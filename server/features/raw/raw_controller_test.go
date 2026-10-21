package raw

import (
	"bufio"
	"context"
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

// getStats fetches one stats response and decodes it.
func getStats(t *testing.T, url string) map[string]any {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("failed to fetch %s: %v", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode %s: %v", url, err)
	}
	return body
}

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

// The bench needs the relay's own view of what it handed to a viewer: when each
// part was written. Without it a gap in the browser has no attribution - the
// producer could have stopped, or the link could have stalled, and the difference
// decides which of the two is broken.
func TestStats_ReportsTheTimelineOfPartsWritten(t *testing.T) {
	holder := NewFrameHolder()
	server := newRawTestServer(t, holder, &fakeSink{})

	resp, err := http.Get(server.URL + "/raw.mjpg")
	if err != nil {
		t.Fatalf("failed to open the stream: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	reader := bufio.NewReader(resp.Body)
	go func() {
		for i := 0; i < 3; i++ {
			holder.PublishCodec(CodecJPEG, []byte{0xff, 0xd8, byte(i), 0xff, 0xd9})
			time.Sleep(10 * time.Millisecond)
		}
	}()
	for i := 0; i < 3; i++ {
		readMJPEGPart(t, reader, mjpegBoundary)
	}

	statsResp, err := http.Get(server.URL + "/raw-stats")
	if err != nil {
		t.Fatalf("failed to read stats: %v", err)
	}
	defer func() { _ = statsResp.Body.Close() }()

	var stats struct {
		Parts uint64  `json:"parts"`
		Times []int64 `json:"times"`
	}
	if err := json.NewDecoder(statsResp.Body).Decode(&stats); err != nil {
		t.Fatalf("stats were not valid JSON: %v", err)
	}
	if stats.Parts < 3 {
		t.Errorf("expected at least 3 parts written, got %d", stats.Parts)
	}
	if len(stats.Times) < 3 {
		t.Errorf("expected a write time for each part, got %d", len(stats.Times))
	}
	for i := 1; i < len(stats.Times); i++ {
		if stats.Times[i] < stats.Times[i-1] {
			t.Fatalf("write times must not go backwards: %v", stats.Times)
		}
	}
}

// The page displays through an <img> fed by multipart/x-mixed-replace, and that
// element gives the page no access to the part headers - so a frame that answers
// an input has to be announced some other way or the page can only report that
// the picture changed, never which input it answered.
func TestInputSocket_EchoesTheStampOfTheFrameThatAnswersIt(t *testing.T) {
	holder := NewFrameHolder()
	server := newRawTestServer(t, holder, &fakeSink{})

	client := dialWebSocket(t, wsURL(server))

	resp, err := http.Get(server.URL + "/raw.mjpg")
	if err != nil {
		t.Fatalf("failed to open the stream: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	reader := bufio.NewReader(resp.Body)

	// A completed handshake on this side does not mean the server has registered
	// the socket yet, so the answering frame is offered repeatedly rather than
	// assuming an order the protocol never promised.
	found := false
	for attempt := 0; attempt < 30 && !found; attempt++ {
		holder.PublishStamped(CodecJPEG, 7, []byte{0xff, 0xd8, 0x07, 0xff, 0xd9})
		readMJPEGPart(t, reader, mjpegBoundary)

		for probe := 0; probe < 10 && !found; probe++ {
			_, payload := client.readFrame(t)
			var message map[string]any
			if err := json.Unmarshal(payload, &message); err != nil {
				continue
			}
			echo, ok := message["echo"]
			if !ok {
				continue
			}
			if number, isNumber := echo.(float64); !isNumber || uint8(number) != 7 {
				t.Fatalf("echoed the wrong stamp: %v", echo)
			}
			found = true
		}
	}

	if !found {
		t.Fatal("a frame carrying an input's stamp was never echoed to the input socket")
	}
}

// A frame that answers nothing must not produce an echo: one message per part
// would be a per-frame tax on the very path the bench is measuring.
func TestInputSocket_StaysSilentForFramesThatAnswerNothing(t *testing.T) {
	holder := NewFrameHolder()
	server := newRawTestServer(t, holder, &fakeSink{})

	client := dialWebSocket(t, wsURL(server))

	resp, err := http.Get(server.URL + "/raw.mjpg")
	if err != nil {
		t.Fatalf("failed to open the stream: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	reader := bufio.NewReader(resp.Body)

	for i := 0; i < 5; i++ {
		holder.PublishCodec(CodecJPEG, []byte{0xff, 0xd8, byte(i), 0xff, 0xd9})
		readMJPEGPart(t, reader, mjpegBoundary)
	}

	for probe := 0; probe < 20; probe++ {
		_, payload := client.readFrame(t)
		var message map[string]any
		if err := json.Unmarshal(payload, &message); err != nil {
			continue
		}
		if _, ok := message["echo"]; ok {
			t.Fatalf("a frame that answered nothing produced an echo: %s", payload)
		}
	}
}

// orderingWriter records how many times the picture stream has been flushed, so a
// test can ask WHEN the stamp echo happened relative to the frame it names.
type orderingWriter struct {
	mu       sync.Mutex
	header   http.Header
	flushes  int
	writtenN int
}

func (w *orderingWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}
func (w *orderingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	w.writtenN += len(p)
	w.mu.Unlock()
	return len(p), nil
}
func (w *orderingWriter) WriteHeader(int) {}
func (w *orderingWriter) Flush() {
	w.mu.Lock()
	w.flushes++
	w.mu.Unlock()
}
func (w *orderingWriter) flushCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.flushes
}

// recordingStampWriter stands in for a page's input socket and remembers how many
// picture flushes had happened when each echo arrived.
type recordingStampWriter struct {
	stream      *orderingWriter
	mu          sync.Mutex
	echoes      []uint8
	flushAtEcho []int
}

func (f *recordingStampWriter) SetWriteDeadline(time.Time) error { return nil }
func (f *recordingStampWriter) WriteText(payload []byte) error {
	var message map[string]any
	if err := json.Unmarshal(payload, &message); err != nil {
		return nil
	}
	if echo, ok := message["echo"].(float64); ok {
		f.mu.Lock()
		f.echoes = append(f.echoes, uint8(echo))
		f.flushAtEcho = append(f.flushAtEcho, f.stream.flushCount())
		f.mu.Unlock()
	}
	return nil
}
func (f *recordingStampWriter) snapshot() ([]uint8, []int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]uint8(nil), f.echoes...), append([]int(nil), f.flushAtEcho...)
}

// The latency the page reports is the time from the input to the change that
// answered it, and the page learns which change that was from the echo. The echo
// used to be written AFTER the frame was flushed, so it could arrive after the
// browser had already decoded and displayed that frame - 19 of 226 echoes in the
// measured run, each of which credited the NEXT frame and overstated that sample
// by about 50ms (a tail metric would not have survived it).
//
// The order is now the other way round: the answering frame is announced before
// its bytes are released. This test pins that down by counting flushes: the echo
// for a stamped frame must arrive while the picture stream is still one part
// behind it.
func TestServeMJPEG_AnnouncesTheStampBeforeItFlushesTheFrame(t *testing.T) {
	holder := NewFrameHolder()
	controller := NewRawController(holder, &fakeSink{})
	stream := &orderingWriter{}
	writer := &recordingStampWriter{stream: stream}
	controller.addInputConn(writer)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/raw.mjpg", nil).WithContext(ctx)
	go controller.ServeMJPEG(stream, req)

	// One unstamped frame, flushed before the answering one is published, so the
	// baseline below counts the header flush and that part.
	holder.PublishStamped(CodecJPEG, 0, []byte{0xff, 0xd8, 0x00, 0xff, 0xd9})
	waitFor(t, "the first part to be flushed", func() bool { return stream.flushCount() >= 2 })
	before := stream.flushCount()

	holder.PublishStamped(CodecJPEG, 9, []byte{0xff, 0xd8, 0x09, 0xff, 0xd9})
	waitFor(t, "the answering frame to be echoed", func() bool {
		echoes, _ := writer.snapshot()
		return len(echoes) > 0
	})

	echoes, flushesAtEcho := writer.snapshot()
	if len(echoes) != 1 || echoes[0] != 9 {
		t.Fatalf("echoed stamps = %v, want exactly one echo of stamp 9", echoes)
	}
	// This test is the only thing that pins the order, and it does so on the
	// flush count the WRITER saw - an observation from outside the relay's own
	// two write calls. The counters that used to sit here compared two timestamps
	// the relay took around its own writes, which is why they reported 908
	// "before" and 0 "after" on every live run and could never fail.
	if flushesAtEcho[0] != before {
		t.Fatalf("the echo arrived after %d picture flush(es), and the stream had flushed %d times before the "+
			"answering frame was published; the echo must be sent BEFORE the frame it names is flushed, or the "+
			"page can see that frame change before it learns which input it answered and credit the next one",
			flushesAtEcho[0], before)
	}
	waitFor(t, "the answering frame itself to be flushed", func() bool { return stream.flushCount() > before })
}

// A bench that samples the byte total a few times a second to see bursts must
// not be handed the whole part timeline with every sample: that is measurement
// traffic on the link being measured.
// The relay's egress counters cannot answer "is the game still reaching me?": with
// no viewer attached they are all zero, and in the failure this exists for - the
// interposer writing frames into a socket the relay never reads - the interposer's
// own send counter keeps climbing. What distinguishes the two is whether the relay
// is still RECEIVING frames, so the stats report that separately.
func TestStats_ReportsHowManyFramesTheRelayHasReceived(t *testing.T) {
	holder := NewFrameHolder()
	server := newRawTestServer(t, holder, &fakeSink{})

	holder.PublishStamped(CodecJPEG, 0, []byte("first"))
	holder.PublishStamped(CodecJPEG, 0, []byte("second"))

	stats := getStats(t, server.URL+"/raw-stats")
	if got := stats["ingested"]; got != float64(2) {
		t.Fatalf("ingested = %v, want 2: the relay received two frames", got)
	}
}

func TestStats_BriefOmitsThePartTimeline(t *testing.T) {
	holder := NewFrameHolder()
	server := newRawTestServer(t, holder, &fakeSink{})
	holder.Publish(encodeTestJPEG(t, 8, 8))

	full := getStats(t, server.URL+"/raw-stats")
	if _, ok := full["times"]; !ok {
		t.Fatal("the full stats response no longer carries the part timeline")
	}

	brief := getStats(t, server.URL+"/raw-stats?brief=1")
	if _, ok := brief["times"]; ok {
		t.Error("brief stats still carry the part timeline")
	}
	if _, ok := brief["bytes"]; !ok {
		t.Error("brief stats dropped the byte total the bench samples")
	}
	if _, ok := brief["echoes"]; !ok {
		t.Error("brief stats dropped the echo counters")
	}
}

// The raw path's wire has exactly one kind of message - a part - and a spike on
// that path cannot be explained without the size of the parts around it and how
// long the relay's write to the browser took. The part timeline has only
// timestamps, which cannot say whether a gap was a quiet link or a 200kB picture
// being pushed into a slow socket.
func TestStats_PartLogCarriesTheSizeOfEveryPartAndItsWriteCost(t *testing.T) {
	holder := NewFrameHolder()
	server := newRawTestServer(t, holder, &fakeSink{})

	stream, err := http.Get(server.URL + "/raw.mjpg")
	if err != nil {
		t.Fatalf("failed to open the stream: %v", err)
	}
	defer func() { _ = stream.Body.Close() }()
	reader := bufio.NewReader(stream.Body)

	image := encodeTestJPEG(t, 16, 16)
	go func() {
		for i := 0; i < 3; i++ {
			holder.PublishStamped(CodecJPEG, uint8(i+1), image)
			time.Sleep(10 * time.Millisecond)
		}
	}()
	for i := 0; i < 3; i++ {
		readMJPEGPart(t, reader, mjpegBoundary)
	}

	stats := getStats(t, server.URL+"/raw-stats?parts=1")
	log, ok := stats["partLog"].([]any)
	if !ok {
		t.Fatalf("stats carry no part log: %v", stats["partLog"])
	}
	if len(log) < 3 {
		t.Fatalf("part log holds %d entries for 3 parts written", len(log))
	}

	entry, ok := log[0].([]any)
	if !ok || len(entry) != 4 {
		t.Fatalf("a part log entry must be [epochMs, bytes, stamp, writeUs], got %v", log[0])
	}
	if got := entry[1].(float64); got != float64(len(image)) {
		t.Errorf("part size logged as %v, want %d - the bytes that went out", got, len(image))
	}
	if got := entry[2].(float64); got != 1 {
		t.Errorf("the stamp the part answered was logged as %v, want 1", got)
	}
	if _, ok := entry[3].(float64); !ok {
		t.Errorf("the write cost was not logged: %v", entry[3])
	}
}
