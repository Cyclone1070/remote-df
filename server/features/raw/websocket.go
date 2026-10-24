package raw

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// The browser side of the raw baseline speaks plain WebSocket, so the server
// needs just enough of RFC 6455 to carry small binary input buffers out and a
// one-line status back. Implementing that here keeps the baseline free of new
// dependencies the rest of the project does not use.
const (
	wsHandshakeGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

	wsOpcodeContinuation byte = 0x0
	wsOpcodeText         byte = 0x1
	wsOpcodeBinary       byte = 0x2
	wsOpcodeClose        byte = 0x8
	wsOpcodePing         byte = 0x9
	wsOpcodePong         byte = 0xA

	// wsMaxMessageBytes caps one browser message. Input buffers are 16 or 17
	// bytes, so anything larger is a client that is not speaking this protocol.
	wsMaxMessageBytes = 1 << 20
)

var (
	errWSHandshake = errors.New("raw ws: invalid websocket handshake")
	errWSProtocol  = errors.New("raw ws: protocol violation")
	errWSTooLarge  = errors.New("raw ws: message exceeds the maximum size")
)

// wsConn is one accepted WebSocket connection. Reads must come from a single
// goroutine; writes are safe from several because they are serialised.
type wsConn struct {
	conn   net.Conn
	reader *bufio.Reader
	writeM sync.Mutex
}

// acceptWebSocket completes the RFC 6455 opening handshake and takes ownership
// of the connection. The response writer must not be used afterwards: the
// connection is hijacked, so net/http no longer manages it.
func acceptWebSocket(w http.ResponseWriter, r *http.Request) (*wsConn, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		!headerHasToken(r.Header, "Connection", "upgrade") ||
		r.Header.Get("Sec-WebSocket-Version") != "13" {
		return nil, errWSHandshake
	}

	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, errWSHandshake
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("raw ws: response writer does not support hijacking")
	}

	conn, buffered, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}

	response := fmt.Sprintf(
		"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",
		wsAcceptKey(key),
	)
	if _, err := buffered.WriteString(response); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := buffered.Flush(); err != nil {
		_ = conn.Close()
		return nil, err
	}

	// buffered.Reader may already hold bytes the client sent right after the
	// handshake, so reads must continue from it rather than from the conn.
	return &wsConn{conn: conn, reader: buffered.Reader}, nil
}

// wsAcceptKey derives the handshake response value from the client's key.
func wsAcceptKey(key string) string {
	sum := sha1.Sum([]byte(key + wsHandshakeGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// headerHasToken reports whether a comma-separated header contains token,
// ignoring case, the way "Connection: keep-alive, Upgrade" must be read.
func headerHasToken(header http.Header, name, token string) bool {
	for _, value := range header.Values(name) {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

// ReadMessage returns the next complete data message, reassembling fragments
// and answering control frames. A close frame ends the stream with io.EOF.
func (c *wsConn) ReadMessage() ([]byte, error) {
	var message []byte
	started := false

	for {
		final, opcode, payload, err := c.readFrame()
		if err != nil {
			return nil, err
		}

		switch opcode {
		case wsOpcodePing:
			if err := c.write(wsOpcodePong, payload); err != nil {
				return nil, err
			}
			continue

		case wsOpcodePong:
			continue

		case wsOpcodeClose:
			// Echo the close so the browser sees an orderly shutdown.
			_ = c.write(wsOpcodeClose, payload)
			return nil, io.EOF

		case wsOpcodeText, wsOpcodeBinary:
			if started {
				return nil, errWSProtocol
			}
			started = true
			message = append(message, payload...)

		case wsOpcodeContinuation:
			if !started {
				return nil, errWSProtocol
			}
			message = append(message, payload...)

		default:
			return nil, errWSProtocol
		}

		if len(message) > wsMaxMessageBytes {
			return nil, errWSTooLarge
		}
		if final {
			return message, nil
		}
	}
}

// readFrame reads one WebSocket frame, unmasking its payload.
func (c *wsConn) readFrame() (bool, byte, []byte, error) {
	var header [2]byte
	if _, err := io.ReadFull(c.reader, header[:]); err != nil {
		return false, 0, nil, err
	}

	final := header[0]&0x80 != 0
	if header[0]&0x70 != 0 {
		// No extensions were negotiated, so reserved bits must be zero.
		return false, 0, nil, errWSProtocol
	}
	opcode := header[0] & 0x0f

	masked := header[1]&0x80 != 0
	length := uint64(header[1] & 0x7f)

	switch length {
	case 126:
		var extended [2]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			return false, 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(extended[:]))
	case 127:
		var extended [8]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			return false, 0, nil, err
		}
		length = binary.BigEndian.Uint64(extended[:])
		if length > 1<<62 {
			return false, 0, nil, errWSProtocol
		}
	}

	if opcode >= wsOpcodeClose && (!final || length > 125) {
		// Control frames cannot be fragmented and cannot carry a long payload.
		return false, 0, nil, errWSProtocol
	}
	if !masked {
		// A client must mask everything it sends.
		return false, 0, nil, errWSProtocol
	}
	if length > wsMaxMessageBytes {
		return false, 0, nil, errWSTooLarge
	}

	var mask [4]byte
	if _, err := io.ReadFull(c.reader, mask[:]); err != nil {
		return false, 0, nil, err
	}

	payload := make([]byte, length)
	if _, err := io.ReadFull(c.reader, payload); err != nil {
		return false, 0, nil, err
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}

	return final, opcode, payload, nil
}

// write sends one unfragmented frame. Server frames are never masked.
func (c *wsConn) write(opcode byte, payload []byte) error {
	c.writeM.Lock()
	defer c.writeM.Unlock()

	frame := make([]byte, 0, len(payload)+10)
	frame = append(frame, 0x80|opcode)

	switch {
	case len(payload) < 126:
		frame = append(frame, byte(len(payload)))
	case len(payload) <= 0xffff:
		frame = append(frame, 126, byte(len(payload)>>8), byte(len(payload)))
	default:
		frame = append(frame, 127)
		var extended [8]byte
		binary.BigEndian.PutUint64(extended[:], uint64(len(payload)))
		frame = append(frame, extended[:]...)
	}
	frame = append(frame, payload...)

	_, err := c.conn.Write(frame)
	return err
}

// WriteText sends a text message, used for the status line the page displays.
func (c *wsConn) WriteText(payload []byte) error {
	return c.write(wsOpcodeText, payload)
}

// WritePing sends a ping so a browser that went away is noticed even while it
// has nothing to say.
// WriteBinary sends a binary frame, which is how the TCP frame probe ships the
// same bytes the data channel would have carried.
func (c *wsConn) WriteBinary(payload []byte) error {
	return c.write(0x2, payload)
}

func (c *wsConn) WritePing(payload []byte) error {
	return c.write(wsOpcodePing, payload)
}

// SetWriteDeadline bounds how long a write may block on a browser that has
// stopped draining its socket. Used by the stamp echo, which has to be written
// before the frame it names is released and therefore cannot be handed to a
// goroutine of its own.
func (c *wsConn) SetWriteDeadline(deadline time.Time) error {
	return c.conn.SetWriteDeadline(deadline)
}

// SetReadDeadline bounds how long a read waits for the browser.
func (c *wsConn) SetReadDeadline(deadline time.Time) error {
	return c.conn.SetReadDeadline(deadline)
}

// Close drops the connection.
func (c *wsConn) Close() error {
	return c.conn.Close()
}
