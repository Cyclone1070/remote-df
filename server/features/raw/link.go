package raw

import (
	"errors"
	"net"
	"sync"
	"time"
)

// ErrNoInterposer reports that input was produced while no interposer was
// connected. The raw baseline is a diagnostic, so input is simply dropped
// rather than buffered: replaying keystrokes into a game that is no longer
// listening would be worse than losing them.
var ErrNoInterposer = errors.New("raw link: no interposer connected")

// inputWriteTimeout bounds how long a browser's input can wait for a wedged
// interposer before that connection is treated as dead.
const inputWriteTimeout = 2 * time.Second

// LinkServer accepts the LD_PRELOAD interposer's TCP connection. One connection
// carries both directions: framed JPEG frames come back from the interposer,
// framed input buffers go out to it.
//
// The interposer is a single client, so connections are served one at a time.
// A restarted interposer reconnects once the previous socket drops.
type LinkServer struct {
	holder *FrameHolder

	mu       sync.Mutex
	listener net.Listener
	conn     net.Conn
	closed   chan struct{}
	shutdown bool

	// writeMu serialises input frames on the connection without holding mu, so
	// a write that stalls cannot stop the accept loop from making progress.
	writeMu sync.Mutex
}

// NewLinkServer creates a link server that publishes decoded frames into holder.
func NewLinkServer(holder *FrameHolder) *LinkServer {
	return &LinkServer{
		holder: holder,
		closed: make(chan struct{}),
	}
}

// Serve accepts interposer connections until the listener fails or Close is
// called. It blocks, so callers run it in its own goroutine.
func (l *LinkServer) Serve(listener net.Listener) error {
	l.mu.Lock()
	if l.shutdown {
		l.mu.Unlock()
		_ = listener.Close()
		return nil
	}
	l.listener = listener
	l.mu.Unlock()

	for {
		conn, err := listener.Accept()
		if err != nil {
			if l.isClosed() {
				return nil
			}
			return err
		}
		l.serveConn(conn)
	}
}

// serveConn reads framed video from one interposer until the connection ends.
func (l *LinkServer) serveConn(conn net.Conn) {
	l.mu.Lock()
	if l.shutdown {
		l.mu.Unlock()
		_ = conn.Close()
		return
	}
	l.conn = conn
	l.mu.Unlock()

	defer func() {
		_ = conn.Close()

		l.mu.Lock()
		if l.conn == conn {
			l.conn = nil
		}
		l.mu.Unlock()
	}()

	for {
		frame, err := readFrame(conn, maxFrameBytes)
		if err != nil {
			// End of stream, a drop, or an unframeable length: in every case
			// this connection is finished and the next accept takes over.
			return
		}
		// The interposer prefixes every frame with a one-byte codec tag. An
		// unknown tag means the two ends disagree about the protocol, so the frame
		// is dropped rather than mislabelled as something it is not.
		if len(frame) < 2 || !Codec(frame[0]).Known() {
			continue
		}
		// Byte 0 is the codec, byte 1 the input stamp being echoed back (0 when
		// none is waiting), and the rest is the picture.
		l.holder.PublishStamped(Codec(frame[0]), frame[1], frame[2:])
	}
}

// SendInput forwards one browser input buffer to the interposer, verbatim, as a
// length-prefixed message. It reports ErrNoInterposer when nothing is connected.
func (l *LinkServer) SendInput(payload []byte) error {
	l.mu.Lock()
	conn := l.conn
	l.mu.Unlock()

	if conn == nil {
		return ErrNoInterposer
	}

	l.writeMu.Lock()
	defer l.writeMu.Unlock()

	// Without a deadline, one stalled interposer would hold the browser's read
	// loop forever instead of being dropped.
	if err := conn.SetWriteDeadline(time.Now().Add(inputWriteTimeout)); err != nil {
		return err
	}

	return writeFrame(conn, payload)
}

// Connected reports whether an interposer is currently attached. The raw page
// shows this so a human can tell "no interposer" from "interposer, no frames".
func (l *LinkServer) Connected() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.conn != nil
}

// Close stops the accept loop and drops the current connection.
func (l *LinkServer) Close() error {
	l.mu.Lock()
	if l.shutdown {
		l.mu.Unlock()
		return nil
	}
	l.shutdown = true
	listener := l.listener
	conn := l.conn
	l.mu.Unlock()

	close(l.closed)

	if listener != nil {
		_ = listener.Close()
	}
	if conn != nil {
		_ = conn.Close()
	}

	return nil
}

func (l *LinkServer) isClosed() bool {
	select {
	case <-l.closed:
		return true
	default:
		return false
	}
}
