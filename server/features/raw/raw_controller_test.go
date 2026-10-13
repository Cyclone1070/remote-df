package raw

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSink stands in for the interposer link so route behaviour can be tested
// without a live interposer.
type fakeSink struct {
	mu        sync.Mutex
	received  [][]byte
	connected bool
	err       error
}

func (f *fakeSink) SendInput(payload []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.received = append(f.received, append([]byte(nil), payload...))
	return f.err
}

func (f *fakeSink) Connected() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.connected
}

func (f *fakeSink) messages() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]byte(nil), f.received...)
}

func newRawTestServer(t *testing.T, holder *FrameHolder, sink InputSink) *httptest.Server {
	t.Helper()

	controller := NewRawController(holder, sink)
	controller.statusInterval = 20 * time.Millisecond

	mux := http.NewServeMux()
	controller.RegisterRoutes(mux)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	return server
}

// mjpegPart is one image in a multipart stream, as a browser would read it.
type mjpegPart struct {
	contentType string
	body        []byte
}

// readMJPEGPart reads the next part of a multipart/x-mixed-replace response.
func readMJPEGPart(t *testing.T, reader *bufio.Reader, boundary string) mjpegPart {
	t.Helper()

	deadline := time.Now().Add(3 * time.Second)

	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("failed to read part delimiter: %v", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "--"+boundary {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no part delimiter on the stream")
		}
	}

	part := mjpegPart{}
	length := -1
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("failed to read part header: %v", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}

		name, value, found := strings.Cut(line, ":")
		if !found {
			t.Fatalf("malformed part header %q", line)
		}
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "content-type":
			part.contentType = strings.TrimSpace(value)
		case "content-length":
			parsed, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				t.Fatalf("malformed content length %q: %v", value, err)
			}
			length = parsed
		}
	}

	if length < 0 {
		t.Fatalf("part has no content length")
	}

	part.body = make([]byte, length)
	if _, err := io.ReadFull(reader, part.body); err != nil {
		t.Fatalf("failed to read part body: %v", err)
	}

	return part
}

func startMJPEGViewer(t *testing.T, server *httptest.Server) (*http.Response, *bufio.Reader, string) {
	t.Helper()

	response, err := http.Get(server.URL + "/raw.mjpg")
	if err != nil {
		t.Fatalf("failed to open the stream: %v", err)
	}
	t.Cleanup(func() {
		_ = response.Body.Close()
	})

	contentType := response.Header.Get("Content-Type")
	boundary := ""
	if _, after, found := strings.Cut(contentType, "boundary="); found {
		boundary = strings.TrimSpace(after)
	}
	if !strings.HasPrefix(contentType, "multipart/x-mixed-replace") || boundary == "" {
		t.Fatalf("unexpected content type %q", contentType)
	}

	return response, bufio.NewReader(response.Body), boundary
}

func TestRawController_StreamsNewestFrameToEveryViewer(t *testing.T) {
	holder := NewFrameHolder()
	server := newRawTestServer(t, holder, &fakeSink{})

	_, firstReader, boundary := startMJPEGViewer(t, server)
	firstFrame := encodeTestJPEG(t, 64, 48)
	holder.Publish(firstFrame)

	part := readMJPEGPart(t, firstReader, boundary)
	if part.contentType != "image/jpeg" {
		t.Errorf("part content type is %q, want image/jpeg", part.contentType)
	}
	if string(part.body) != string(firstFrame) {
		t.Fatalf("viewer received %d bytes, want the %d byte frame", len(part.body), len(firstFrame))
	}

	// A second browser joining later must get its own stream, seeded with the
	// frame that is already current.
	_, secondReader, secondBoundary := startMJPEGViewer(t, server)
	if secondBoundary != boundary {
		t.Fatalf("boundaries differ between viewers: %q and %q", boundary, secondBoundary)
	}
	seeded := readMJPEGPart(t, secondReader, secondBoundary)
	if string(seeded.body) != string(firstFrame) {
		t.Fatalf("late viewer was not seeded with the current frame")
	}

	// Both viewers must see the next frame.
	secondFrame := encodeTestJPEG(t, 32, 16)
	holder.Publish(secondFrame)
	for name, reader := range map[string]*bufio.Reader{"first": firstReader, "second": secondReader} {
		part := readMJPEGPart(t, reader, boundary)
		if string(part.body) != string(secondFrame) {
			t.Errorf("%s viewer received %d bytes, want the newest frame", name, len(part.body))
		}
	}

}

// A viewer that stops reading must not stop the interposer or the other
// viewers: its frames are dropped, not queued.
func TestRawController_SlowViewerDoesNotBlockOthers(t *testing.T) {
	holder := NewFrameHolder()
	server := newRawTestServer(t, holder, &fakeSink{})

	_, slowReader, _ := startMJPEGViewer(t, server)
	holder.Publish(encodeTestJPEG(t, 64, 48))
	if _, err := slowReader.Peek(1); err != nil {
		t.Fatalf("slow viewer never received its first part: %v", err)
	}

	// The slow viewer now stops reading entirely.
	_, fastReader, boundary := startMJPEGViewer(t, server)
	readMJPEGPart(t, fastReader, boundary)

	frame := encodeTestJPEG(t, 96, 64)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			holder.Publish(frame)
		}
	}()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("publishing blocked behind a viewer that stopped reading")
	}

	part := readMJPEGPart(t, fastReader, boundary)
	if string(part.body) != string(frame) {
		t.Fatalf("active viewer received %d bytes, want the %d byte frame", len(part.body), len(frame))
	}
}

func TestRawController_ForwardsBrowserInputToSink(t *testing.T) {
	sink := &fakeSink{connected: true}
	server := newRawTestServer(t, NewFrameHolder(), sink)

	client := dialWebSocket(t, "ws"+strings.TrimPrefix(server.URL, "http")+"/raw-input")

	keyDown := []byte{16, 0, 0, 0, 0, 0, 0x61, 0, 0, 0, 0x04, 0, 0, 0, 0, 0}
	client.writeFrame(t, true, wsOpcodeBinary, keyDown)

	waitFor(t, "the input to reach the sink", func() bool {
		return len(sink.messages()) == 1
	})
	if got := sink.messages()[0]; string(got) != string(keyDown) {
		t.Fatalf("sink received % x, want % x", got, keyDown)
	}

	// With no interposer connected the input is dropped, and the browser's
	// connection must survive: the page has to keep working while a human waits
	// for the interposer to come up.
	sink.mu.Lock()
	sink.err = ErrNoInterposer
	sink.connected = false
	sink.mu.Unlock()

	mouseMove := []byte{1, 0x10, 0, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	client.writeFrame(t, true, wsOpcodeBinary, mouseMove)

	waitFor(t, "the dropped input to be recorded", func() bool {
		return len(sink.messages()) == 2
	})
	if got := sink.messages()[1]; string(got) != string(mouseMove) {
		t.Fatalf("sink received % x, want % x", got, mouseMove)
	}
}

func TestRawController_StatusReportsFrameRateAndSize(t *testing.T) {
	holder := NewFrameHolder()
	sink := &fakeSink{connected: true}
	server := newRawTestServer(t, holder, sink)

	holder.Publish(encodeTestJPEG(t, 320, 200))
	holder.Publish(encodeTestJPEG(t, 320, 200))

	client := dialWebSocket(t, "ws"+strings.TrimPrefix(server.URL, "http")+"/raw-input")

	opcode, payload := client.readFrame(t)
	if opcode != wsOpcodeText {
		t.Fatalf("expected a text status frame, got opcode %#x", opcode)
	}

	var status struct {
		FPS     float64 `json:"fps"`
		Width   int     `json:"w"`
		Height  int     `json:"h"`
		Frames  uint64  `json:"frames"`
		Link    bool    `json:"link"`
		Viewers int     `json:"viewers"`
	}
	if err := json.Unmarshal(payload, &status); err != nil {
		t.Fatalf("status %q is not valid json: %v", payload, err)
	}

	if status.Width != 320 || status.Height != 200 {
		t.Errorf("status reports size %dx%d, want 320x200", status.Width, status.Height)
	}
	if status.Frames < 2 {
		t.Errorf("status reports %d frames, want at least 2", status.Frames)
	}
	if !status.Link {
		t.Errorf("status does not report the connected interposer")
	}
	if status.FPS < 0 {
		t.Errorf("status reports a negative frame rate: %f", status.FPS)
	}
}

func TestRawController_StatusWithoutFrames(t *testing.T) {
	server := newRawTestServer(t, NewFrameHolder(), &fakeSink{})

	client := dialWebSocket(t, "ws"+strings.TrimPrefix(server.URL, "http")+"/raw-input")

	opcode, payload := client.readFrame(t)
	if opcode != wsOpcodeText {
		t.Fatalf("expected a text status frame, got opcode %#x", opcode)
	}

	var status struct {
		FPS    float64 `json:"fps"`
		Width  int     `json:"w"`
		Height int     `json:"h"`
		Frames uint64  `json:"frames"`
		Link   bool    `json:"link"`
	}
	if err := json.Unmarshal(payload, &status); err != nil {
		t.Fatalf("status %q is not valid json: %v", payload, err)
	}

	if status.FPS != 0 || status.Width != 0 || status.Height != 0 || status.Frames != 0 {
		t.Errorf("expected an idle status before any frame, got %s", payload)
	}

	if status.Link {
		t.Errorf("status claims an interposer is connected when none is")
	}
}

func TestRawController_RejectsRequestWithoutUpgrade(t *testing.T) {
	server := newRawTestServer(t, NewFrameHolder(), &fakeSink{})

	response, err := http.Get(server.URL + "/raw-input")
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
