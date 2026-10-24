package raw

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// mjpegBoundary separates the parts of the raw frame stream. It only has to
	// be a string that cannot appear inside a JPEG payload's framing.
	mjpegBoundary = "dfrawframe"

	// mjpegPartOverhead is the per-part multipart framing around each JPEG, so
	// the byte comparison counts what actually crossed the link rather than the
	// image payload alone.
	mjpegPartOverhead = 64

	// statusInterval is how often the overlay's frame rate is refreshed.
	statusInterval = time.Second

	// inputReadTimeout bounds a silent browser connection. The page answers the
	// server's pings, so a connection that stays quiet for this long is gone.
	inputReadTimeout = 90 * time.Second

	// statusPingInterval is how often the server pings the browser to keep the
	// read deadline above alive.
	statusPingInterval = 30 * time.Second

	// echoWriteTimeout bounds the stamp echo. The echo is written from the
	// picture loop, before the frame it names is released, because that ordering
	// is what makes the page's pairing causal - so it cannot be handed to a
	// goroutine of its own the way it used to be. The timeout is what keeps a
	// browser that has stopped draining its input socket from stalling the
	// video loop behind it: an echo that cannot be written in this long is
	// dropped, and a dropped echo costs one latency sample instead of putting a
	// wrong one in the results.
	echoWriteTimeout = 250 * time.Millisecond
)

// stampWriter is the part of a page's input socket that the picture loop needs:
// one text write, bounded by a deadline.
type stampWriter interface {
	WriteText(payload []byte) error
	SetWriteDeadline(deadline time.Time) error
}

// InputSink is the part of the interposer link the browser-facing side needs.
// It is an interface so the routes can be tested without a live interposer.
type InputSink interface {
	// SendInput forwards one browser input buffer verbatim.
	SendInput(payload []byte) error
	// Connected reports whether an interposer is attached.
	Connected() bool
}

// RawController serves the raw pixel baseline: whole JPEG frames over
// multipart/x-mixed-replace, with browser input shipped straight to the
// interposer.
//
// This baseline deliberately does nothing smart. It exists to answer "do whole
// pictures arrive at all" without the draw-command protocol in the way, so
// every route here is independent of the project's normal streaming path.
type RawController struct {
	holder *FrameHolder
	sink   InputSink

	// tcpFrames is the TCP probe's fan-out, nil unless the process runs one.
	tcpFrames *TCPFrameHub

	// statusInterval is a field so tests can watch several status frames
	// without waiting a second for each one.
	statusInterval time.Duration

	// Bytes handed to browsers, so the whole-picture cost can be compared with
	// the draw-command path on the same scenario. Counted where the bytes are
	// written, which is the last point this side controls.
	wireBytes  atomic.Uint64
	wireFrames atomic.Uint64

	// When each part was handed to a viewer, in epoch milliseconds, capped to
	// the most recent window. This is the producer's clock for the raw path: a
	// gap in the browser can be attributed to the relay having stopped, or to
	// the link having stalled while the relay kept writing, and those two are
	// different bugs.
	partMu    sync.Mutex
	partTimes []int64
	partCount uint64
	// The same parts with what a spike needs: how many bytes went out, which
	// input the frame answered, and how long the write to the browser took. The
	// raw path has one kind of message and this is it - a log that did not carry
	// the size of each part could not tell a quiet link from a 200kB picture
	// pushed into a socket that was not being read.
	partLog [][4]int64

	// The input sockets of viewers that are currently attached, so a frame that
	// answers an input can tell the page it is answering it. The stamp rides the
	// picture stream as a header, which the <img> that displays it cannot read.
	inputMu    sync.Mutex
	inputConns map[stampWriter]struct{}

	// Echo accounting. `echoes` is stamps announced to a page, `echoDropped` is
	// echoes that could not be written inside echoWriteTimeout. Both are here
	// because a dropped echo is invisible on the page - it shows up only as a
	// latency sample that never happened - and the bench has to be able to tell
	// that from a sample it simply did not get.
	echoes      atomic.Uint64
	echoDropped atomic.Uint64

	// The ordering of the two writes is NOT instrumented, and used to be. The
	// counters that claimed to measure it (echoBeforeFlush/echoAfterFlush/
	// echoLeadUs) compared two timestamps this process took around its own write
	// calls, so the echo was always "first" - live: 908 before, 0 after, on every
	// run. Write order within one process is not delivery order across two
	// transports, and the page cannot observe the frame's own arrival without a
	// second subscription to the stream, so there was nothing to measure. What
	// the ordering guarantee rests on is the Go test that pins the echo to before
	// the flush (see TestEchoBeforeFlush in raw_controller_test.go).
}

// partTimelineMax bounds the retained write times. A bench window is seconds
// long; keeping the process's whole history would make the stats response grow
// without limit on a baseline that is meant to run for hours.
const partTimelineMax = 8000

// notePart records that one part has just been handed to a viewer: when, how
// many bytes, which input it answered, and how long the write itself took.
// writeUs is the whole of writeImagePart plus the flush, so it includes time
// spent waiting for the browser to take the bytes - which is the raw path's
// equivalent of a deep send queue.
func (c *RawController) notePart(bytes int, stamp uint8, writeUs int64) {
	c.partMu.Lock()
	c.partTimes = append(c.partTimes, time.Now().UnixMilli())
	if len(c.partTimes) > partTimelineMax {
		kept := make([]int64, partTimelineMax/2)
		copy(kept, c.partTimes[len(c.partTimes)-len(kept):])
		c.partTimes = kept
	}
	c.partLog = append(c.partLog, [4]int64{time.Now().UnixMilli(), int64(bytes), int64(stamp), writeUs})
	if len(c.partLog) > partTimelineMax {
		kept := make([][4]int64, partTimelineMax/2)
		copy(kept, c.partLog[len(c.partLog)-len(kept):])
		c.partLog = kept
	}
	c.partCount++
	c.partMu.Unlock()
}

// partDetail returns the part log and the total written.
func (c *RawController) partDetail() ([][4]int64, uint64) {
	c.partMu.Lock()
	defer c.partMu.Unlock()
	return append([][4]int64(nil), c.partLog...), c.partCount
}

// partTimeline returns the retained write times and the total written.
func (c *RawController) partTimeline() ([]int64, uint64) {
	c.partMu.Lock()
	defer c.partMu.Unlock()
	return append([]int64(nil), c.partTimes...), c.partCount
}

// NewRawController creates a controller that reads frames from holder and
// forwards input to sink.
func NewRawController(holder *FrameHolder, sink InputSink) *RawController {
	return &RawController{
		holder:         holder,
		sink:           sink,
		statusInterval: statusInterval,
		inputConns:     make(map[stampWriter]struct{}),
	}
}

// RegisterRoutes mounts the raw baseline routes onto its own mux. The raw
// listeners use a separate port and a separate mux, so no existing route or
// handler is touched.
func (c *RawController) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /", c.ServePage)
	mux.HandleFunc("GET /raw.mjpg", c.ServeMJPEG)
	mux.HandleFunc("GET /raw-input", c.ServeInput)
	mux.HandleFunc("GET /raw-stats", c.ServeStats)
	if c.tcpFrames != nil {
		mux.HandleFunc("GET /frames-tcp", c.tcpFrames.ServeWS)
	}
}

// ServeStats reports the running byte total as JSON so a bench can sample it
// before and after a scenario without scraping the log.
func (c *RawController) ServeStats(w http.ResponseWriter, r *http.Request) {
	times, parts := c.partTimeline()
	viewerDelivered, viewerReplaced := c.holder.ViewerCounters()

	body := map[string]any{
		// The relay's own clock, so a bench can put the host-side part log on
		// the page's timeline without assuming the two machines agree.
		"now":         time.Now().UnixMilli(),
		"bytes":       c.wireBytes.Load(),
		"frames":      c.wireFrames.Load(),
		"echoes":      c.echoes.Load(),
		"echoDropped": c.echoDropped.Load(),
		// Frames the relay has actually received from the game. The egress
		// counters below it are all zero with no viewer attached, so they cannot
		// answer whether the link is alive.
		"ingested": c.holder.Count(),
		"viewers":  c.holder.SubscriberCount(),
		// Frames thrown away because a viewer still held the previous one. The
		// pixel path has always dropped these by design; it simply never said so,
		// which made "the relay sent 40 frames a second" and "the browser saw 11"
		// look like a mystery instead of arithmetic.
		"viewerFrames":   viewerDelivered,
		"viewerReplaced": viewerReplaced,
		"parts":          parts,
	}
	// The part timeline is thousands of timestamps and only a diagnostic wants
	// it. A bench that samples the byte total several times a second to see
	// bursts does not, and making it carry the timeline would put tens of
	// kilobytes a second of measurement traffic on the very link being measured.
	if r.URL.Query().Get("brief") != "1" {
		body["times"] = times
	}
	// The part log is the spike forensics' own view of this path's wire, and it
	// is read once at the end of a run rather than sampled, so it is asked for
	// explicitly and never rides on the polled counters.
	if r.URL.Query().Get("parts") == "1" {
		detail, _ := c.partDetail()
		body["partLog"] = detail
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(body)
}

// ServeMJPEG streams the newest frame to one browser as a multipart response.
//
// Each browser gets its own subscriber, and a subscriber only ever holds the
// newest frame, so a browser that reads slowly loses frames instead of holding
// up the interposer or the other viewers.
func (c *RawController) ServeMJPEG(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary="+mjpegBoundary)
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	subscriber := c.holder.Subscribe()
	defer c.holder.Unsubscribe(subscriber)

	for {
		select {
		case <-r.Context().Done():
			return

		case frame, open := <-subscriber.Frames():
			if !open {
				return
			}
			// Announced before the bytes, never after: see echoStamp. The order
			// of these two writes is the whole point, and it is pinned by a test
			// (TestEchoBeforeFlush) rather than by a counter that could not fail.
			if frame.Stamp != 0 {
				c.echoStamp(frame.Stamp)
			}
			partStarted := time.Now()
			if err := writeImagePart(w, frame.Codec, frame.Stamp, frame.Image); err != nil {
				// The browser went away mid-write; its own context usually
				// reports this too, but a failed write is decisive.
				return
			}
			c.wireBytes.Add(uint64(len(frame.Image)) + mjpegPartOverhead)
			c.wireFrames.Add(1)
			flusher.Flush()
			// Recorded after the flush, not before: "written" must mean the bytes
			// reached the socket, otherwise the log claims delivery for a frame the
			// write is about to fail on.
			serverEvents.Note(ServerFrameWritten, frame.Seq, subscriber.id, int64(len(frame.Image)), 0, 0)
			// Measured to after the flush: if the browser is not reading, this is
			// where the relay waits, and a frame behind that wait is late for a
			// reason that has nothing to do with the game or the link.
			c.notePart(len(frame.Image), frame.Stamp, time.Since(partStarted).Microseconds())
		}
	}
}

// writeImagePart writes one image part and its trailing separator, declaring the
// displays nothing at all, so this is not cosmetic.
func writeImagePart(w http.ResponseWriter, codec Codec, stamp uint8, image []byte) error {
	// The stamp rides as a header so a client that parses the stream can time its
	// own input round trip without the picture format having to know about it.
	if _, err := fmt.Fprintf(w, "--%s\r\nContent-Type: %s\r\nContent-Length: %d\r\nX-DF-Stamp: %d\r\n\r\n",
		mjpegBoundary, codec.ContentType(), len(image), stamp); err != nil {
		return err
	}
	if _, err := w.Write(image); err != nil {
		return err
	}

	_, err := w.Write([]byte("\r\n"))
	return err
}

// echoStamp tells the page that the frame answering one of its inputs is about
// to be written to it.
//
// The stamp is a header on the picture stream, and the element that displays that
// stream gives the page no access to its headers - so without this the page can
// see that the picture changed but not which input the change answered, and any
// latency it reported would be the time to some other frame's redraw. The echo
// goes on the socket the page already holds for input and status; it adds one
// small message per input that visibly changed the picture, and nothing at all to
// the picture stream.
//
// It is written synchronously, BEFORE the frame's bytes are released to the
// picture stream, and that order is the whole point. Written afterwards - which
// is what this did - the echo races the browser's decode of the frame it names:
// when the decode wins, the page has already seen the change by the time the
// echo arrives, its rule "the first change after the echo is the answer" skips
// that frame and credits the next one, and the sample it reports is a whole
// frame too long. Measured before the fix: 19 of 226 echoes arrived after the
// frame they named was displayed. Announced first, the frame cannot be displayed
// before the page knows which input it answers.
//
// Bounded by echoWriteTimeout, so a viewer that has stopped reading its input
// socket costs a dropped echo rather than a stalled video loop.
func (c *RawController) echoStamp(stamp uint8) {
	payload, err := json.Marshal(map[string]any{"echo": stamp, "t": time.Now().UnixMilli()})
	if err != nil {
		return
	}

	c.inputMu.Lock()
	conns := make([]stampWriter, 0, len(c.inputConns))
	for conn := range c.inputConns {
		conns = append(conns, conn)
	}
	c.inputMu.Unlock()

	for _, conn := range conns {
		_ = conn.SetWriteDeadline(time.Now().Add(echoWriteTimeout))
		if err := conn.WriteText(payload); err != nil {
			c.echoDropped.Add(1)
			continue
		}
		c.echoes.Add(1)
	}
}

// SetTCPFrameHub attaches the TCP frame probe, when the process runs one.
func (c *RawController) SetTCPFrameHub(h *TCPFrameHub) { c.tcpFrames = h }

// addInputConn registers a page's input socket so frames that answer its inputs
// can be announced to it.
func (c *RawController) addInputConn(conn stampWriter) {
	c.inputMu.Lock()
	c.inputConns[conn] = struct{}{}
	c.inputMu.Unlock()
}

func (c *RawController) removeInputConn(conn stampWriter) {
	c.inputMu.Lock()
	delete(c.inputConns, conn)
	c.inputMu.Unlock()
}

// ServeInput accepts the page's WebSocket and forwards every binary message to
// the interposer exactly as it arrived. Status frames travel the other way so
// the page can show that the stream is alive.
func (c *RawController) ServeInput(w http.ResponseWriter, r *http.Request) {
	ws, err := acceptWebSocket(w, r)
	if err != nil {
		http.Error(w, "expected a websocket upgrade", http.StatusBadRequest)
		return
	}
	defer func() {
		_ = ws.Close()
	}()

	done := make(chan struct{})
	defer close(done)

	c.addInputConn(ws)
	defer c.removeInputConn(ws)

	go c.pushStatus(ws, done)

	for {
		if err := ws.SetReadDeadline(time.Now().Add(inputReadTimeout)); err != nil {
			return
		}

		payload, err := ws.ReadMessage()
		if err != nil {
			// A closed browser, a protocol violation or an idle timeout all
			// mean this connection is finished.
			return
		}
		if len(payload) == 0 {
			continue
		}

		// A failed send means this event is dropped, nothing more. With no
		// interposer attached that is the normal case, and the link reports its
		// own state to the overlay, so the browser's connection stays up either
		// way: a human waiting for the interposer must not have to reload.
		_ = c.sink.SendInput(payload)
	}
}

// rawStatus is what the page's overlay displays.
type rawStatus struct {
	FPS     float64 `json:"fps"`
	Width   int     `json:"w"`
	Height  int     `json:"h"`
	Frames  uint64  `json:"frames"`
	Link    bool    `json:"link"`
	Viewers int     `json:"viewers"`
}

// pushStatus sends the overlay's numbers once per interval until the connection
// ends. The frame rate is measured here rather than in the browser because a
// multipart image element reports neither frames nor their arrival times.
func (c *RawController) pushStatus(ws *wsConn, done <-chan struct{}) {
	ticker := time.NewTicker(c.statusInterval)
	defer ticker.Stop()

	var previousFrames uint64
	previousAt := time.Now()
	sincePing := time.Duration(0)

	for {
		select {
		case <-done:
			return

		case now := <-ticker.C:
			frame, ok := c.holder.Latest()

			var frames uint64
			if ok {
				frames = frame.Seq
			}

			elapsed := now.Sub(previousAt).Seconds()
			fps := 0.0
			if elapsed > 0 {
				fps = float64(frames-previousFrames) / elapsed
			}
			previousFrames = frames
			previousAt = now

			status := rawStatus{
				FPS:     fps,
				Frames:  frames,
				Link:    c.sink.Connected(),
				Viewers: c.holder.SubscriberCount(),
			}
			if ok {
				status.Width = frame.Width
				status.Height = frame.Height
			}

			encoded, err := json.Marshal(status)
			if err != nil {
				return
			}
			if err := ws.WriteText(encoded); err != nil {
				return
			}

			// Pings keep a browser that is not sending anything from tripping
			// the read deadline.
			sincePing += c.statusInterval
			if sincePing >= statusPingInterval {
				sincePing = 0
				if err := ws.WritePing(nil); err != nil {
					return
				}
			}
		}
	}
}
