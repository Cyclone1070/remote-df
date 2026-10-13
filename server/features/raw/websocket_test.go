package raw

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// testWSClient is a hand-rolled WebSocket client. Writing the client side by
// hand is deliberate: it pins the exact bytes the server must produce, which a
// library would hide.
type testWSClient struct {
	conn   net.Conn
	reader *bufio.Reader
}

func dialWebSocket(t *testing.T, rawURL string) *testWSClient {
	t.Helper()

	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("failed to parse url %q: %v", rawURL, err)
	}

	conn, err := net.Dial("tcp", parsed.Host)
	if err != nil {
		t.Fatalf("failed to dial %s: %v", parsed.Host, err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})

	key := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef"))
	handshake := fmt.Sprintf(
		"GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n",
		parsed.Path, parsed.Host, key,
	)
	if _, err := conn.Write([]byte(handshake)); err != nil {
		t.Fatalf("failed to send handshake: %v", err)
	}

	reader := bufio.NewReader(conn)
	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("failed to set read deadline: %v", err)
	}

	status, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("failed to read handshake response: %v", err)
	}
	if !strings.Contains(status, "101") {
		t.Fatalf("expected a 101 response, got %q", strings.TrimSpace(status))
	}

	headers := http.Header{}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("failed to read handshake headers: %v", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		name, value, found := strings.Cut(line, ":")
		if found {
			headers.Add(strings.TrimSpace(name), strings.TrimSpace(value))
		}
	}

	sum := sha1.Sum([]byte(key + wsHandshakeGUID))
	wantAccept := base64.StdEncoding.EncodeToString(sum[:])
	if got := headers.Get("Sec-WebSocket-Accept"); got != wantAccept {
		t.Fatalf("Sec-WebSocket-Accept is %q, want %q", got, wantAccept)
	}

	return &testWSClient{conn: conn, reader: reader}
}

func (c *testWSClient) writeFrame(t *testing.T, final bool, opcode byte, payload []byte) {
	t.Helper()

	frame := []byte{opcode}
	if final {
		frame[0] |= 0x80
	}

	mask := [4]byte{0x11, 0x22, 0x33, 0x44}
	switch {
	case len(payload) < 126:
		frame = append(frame, 0x80|byte(len(payload)))
	case len(payload) <= 0xffff:
		frame = append(frame, 0x80|126, byte(len(payload)>>8), byte(len(payload)))
	default:
		frame = append(frame, 0x80|127)
		var extended [8]byte
		binary.BigEndian.PutUint64(extended[:], uint64(len(payload)))
		frame = append(frame, extended[:]...)
	}
	frame = append(frame, mask[:]...)

	masked := make([]byte, len(payload))
	for i, b := range payload {
		masked[i] = b ^ mask[i%4]
	}
	frame = append(frame, masked...)

	if _, err := c.conn.Write(frame); err != nil {
		t.Fatalf("failed to write frame: %v", err)
	}
}

func (c *testWSClient) writeUnmaskedFrame(t *testing.T, opcode byte, payload []byte) {
	t.Helper()

	frame := append([]byte{0x80 | opcode, byte(len(payload))}, payload...)
	if _, err := c.conn.Write(frame); err != nil {
		t.Fatalf("failed to write frame: %v", err)
	}
}

func (c *testWSClient) readFrame(t *testing.T) (byte, []byte) {
	t.Helper()

	if err := c.conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("failed to set read deadline: %v", err)
	}

	var header [2]byte
	if _, err := io.ReadFull(c.reader, header[:]); err != nil {
		t.Fatalf("failed to read frame header: %v", err)
	}
	if header[1]&0x80 != 0 {
		t.Fatalf("server frames must not be masked")
	}

	length := uint64(header[1] & 0x7f)
	switch length {
	case 126:
		var extended [2]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			t.Fatalf("failed to read extended length: %v", err)
		}
		length = uint64(binary.BigEndian.Uint16(extended[:]))
	case 127:
		var extended [8]byte
		if _, err := io.ReadFull(c.reader, extended[:]); err != nil {
			t.Fatalf("failed to read extended length: %v", err)
		}
		length = binary.BigEndian.Uint64(extended[:])
	}

	payload := make([]byte, length)
	if _, err := io.ReadFull(c.reader, payload); err != nil {
		t.Fatalf("failed to read frame payload: %v", err)
	}

	return header[0] & 0x0f, payload
}

// newWSHandlerServer starts a test server whose handler accepts the handshake
// and reports every message it reads, plus the reason it stopped.
func newWSHandlerServer(t *testing.T, messages chan<- []byte, stopped chan<- error) *httptest.Server {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := acceptWebSocket(w, r)
		if err != nil {
			stopped <- err
			return
		}
		defer func() {
			_ = ws.Close()
		}()

		for {
			message, err := ws.ReadMessage()
			if err != nil {
				stopped <- err
				return
			}
			messages <- message
		}
	}))
	t.Cleanup(server.Close)

	return server
}

func wsURL(server *httptest.Server) string {
	return "ws" + strings.TrimPrefix(server.URL, "http") + "/raw-input"
}

func TestWebSocket_DeliversMaskedBinaryInput(t *testing.T) {
	messages := make(chan []byte, 4)
	stopped := make(chan error, 1)
	server := newWSHandlerServer(t, messages, stopped)

	client := dialWebSocket(t, wsURL(server))

	// The exact bytes the page builds for a key down: type 16, int16 x and y,
	// uint8 button, uint32 sym, uint32 scancode, uint16 modifiers.
	input := []byte{16, 0, 0, 0, 0, 0, 0x61, 0, 0, 0, 0x04, 0, 0, 0, 0, 0}
	client.writeFrame(t, true, wsOpcodeBinary, input)

	select {
	case got := <-messages:
		if string(got) != string(input) {
			t.Fatalf("handler received % x, want % x", got, input)
		}
	case err := <-stopped:
		t.Fatalf("handler stopped before delivering input: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatalf("handler never received the input message")
	}
}

func TestWebSocket_AnswersPingAndClosesCleanly(t *testing.T) {
	messages := make(chan []byte, 4)
	stopped := make(chan error, 1)
	server := newWSHandlerServer(t, messages, stopped)

	client := dialWebSocket(t, wsURL(server))

	client.writeFrame(t, true, wsOpcodePing, []byte("hi"))
	opcode, payload := client.readFrame(t)
	if opcode != wsOpcodePong {
		t.Fatalf("expected a pong frame, got opcode %#x", opcode)
	}
	if string(payload) != "hi" {
		t.Fatalf("pong payload is %q, want %q", payload, "hi")
	}

	// A close frame must be echoed and must end the handler.
	client.writeFrame(t, true, wsOpcodeClose, []byte{0x03, 0xe8})
	opcode, _ = client.readFrame(t)
	if opcode != wsOpcodeClose {
		t.Fatalf("expected a close frame in reply, got opcode %#x", opcode)
	}

	select {
	case err := <-stopped:
		if err != io.EOF {
			t.Fatalf("expected the handler to stop with io.EOF, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("handler did not stop after the close frame")
	}
}

func TestWebSocket_ReassemblesFragmentedMessage(t *testing.T) {
	messages := make(chan []byte, 4)
	stopped := make(chan error, 1)
	server := newWSHandlerServer(t, messages, stopped)

	client := dialWebSocket(t, wsURL(server))

	// Two fragments of one binary message, as a client with a small send buffer
	// would produce.
	client.writeFrame(t, false, wsOpcodeBinary, []byte{16, 0, 0})
	client.writeFrame(t, true, wsOpcodeContinuation, []byte{0, 0, 0, 0x61})

	select {
	case got := <-messages:
		want := []byte{16, 0, 0, 0, 0, 0, 0x61}
		if string(got) != string(want) {
			t.Fatalf("handler received % x, want % x", got, want)
		}
	case err := <-stopped:
		t.Fatalf("handler stopped before reassembling: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatalf("handler never received the reassembled message")
	}
}

func TestWebSocket_RejectsUnmaskedClientFrame(t *testing.T) {
	messages := make(chan []byte, 4)
	stopped := make(chan error, 1)
	server := newWSHandlerServer(t, messages, stopped)

	client := dialWebSocket(t, wsURL(server))
	client.writeUnmaskedFrame(t, wsOpcodeBinary, []byte{16, 0, 0})

	select {
	case err := <-stopped:
		if err != errWSProtocol {
			t.Fatalf("expected a protocol error, got %v", err)
		}
	case message := <-messages:
		t.Fatalf("server accepted an unmasked client frame: % x", message)
	case <-time.After(2 * time.Second):
		t.Fatalf("handler neither rejected the frame nor stopped")
	}
}

func TestWebSocket_RejectsNonHandshakeRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := acceptWebSocket(w, r); err == nil {
			t.Errorf("expected the handshake to be rejected")
		}
		w.WriteHeader(http.StatusBadRequest)
	}))
	t.Cleanup(server.Close)

	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer func() {
		_ = response.Body.Close()
	}()

	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", response.StatusCode)
	}
}
