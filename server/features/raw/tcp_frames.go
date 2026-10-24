package raw

import (
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"sync"
)

// TCP frame probe.
//
// The frame stream normally travels on the WebRTC data channel (SCTP over UDP),
// which was measured stalling for 326 ms and then delivering nine frames in
// 0.6 ms - with the sender's queue empty and the network showing 0% loss. To
// answer whether that is the transport or the wire, the same frames are also
// sent over plain TCP, and both arrival times are compared on the client.
//
// Deliberately not a second implementation of anything: it accepts frames on a
// socket, timestamps them, and hands them to any watching page. It decides
// nothing and changes nothing about the product path.
type TCPFrameHub struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
}

func NewTCPFrameHub() *TCPFrameHub {
	return &TCPFrameHub{subs: map[chan []byte]struct{}{}}
}

func (h *TCPFrameHub) subscribe() chan []byte {
	ch := make(chan []byte, 64)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *TCPFrameHub) unsubscribe(ch chan []byte) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

func (h *TCPFrameHub) broadcast(b []byte) {
	h.mu.Lock()
	subs := make([]chan []byte, 0, len(h.subs))
	for ch := range h.subs {
		subs = append(subs, ch)
	}
	h.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- b:
		default:
			// A page that cannot keep up is not a measurement any more.
		}
	}
}

// ServeTCP accepts the interposer's frame stream: a 4-byte big-endian length
// followed by that many bytes. One connection is expected.
func (h *TCPFrameHub) ServeTCP(ln net.Listener) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return err
		}
		go func(c net.Conn) {
			defer func() { _ = c.Close() }()
			var hdr [4]byte
			for {
				if _, err := io.ReadFull(c, hdr[:]); err != nil {
					return
				}
				n := binary.BigEndian.Uint32(hdr[:])
				if n == 0 || n > 1<<22 {
					return
				}
				buf := make([]byte, n)
				if _, err := io.ReadFull(c, buf); err != nil {
					return
				}
				h.broadcast(buf)
			}
		}(conn)
	}
}

// ServeWS gives a page the same frames over a WebSocket, so their arrival can be
// timestamped in the browser next to the data channel's.
func (h *TCPFrameHub) ServeWS(w http.ResponseWriter, r *http.Request) {
	ws, err := acceptWebSocket(w, r)
	if err != nil {
		http.Error(w, "expected a websocket upgrade", http.StatusBadRequest)
		return
	}
	defer func() { _ = ws.Close() }()

	ch := h.subscribe()
	defer h.unsubscribe(ch)

	for payload := range ch {
		if err := ws.WriteBinary(payload); err != nil {
			return
		}
	}
}
