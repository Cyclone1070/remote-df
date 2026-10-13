package raw

import (
	"encoding/json"
	"fmt"
	"net/http"
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
)

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

	// statusInterval is a field so tests can watch several status frames
	// without waiting a second for each one.
	statusInterval time.Duration

	// Bytes handed to browsers, so the whole-picture cost can be compared with
	// the draw-command path on the same scenario. Counted where the bytes are
	// written, which is the last point this side controls.
	wireBytes  atomic.Uint64
	wireFrames atomic.Uint64
}

// NewRawController creates a controller that reads frames from holder and
// forwards input to sink.
func NewRawController(holder *FrameHolder, sink InputSink) *RawController {
	return &RawController{
		holder:         holder,
		sink:           sink,
		statusInterval: statusInterval,
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
}

// ServeStats reports the running byte total as JSON so a bench can sample it
// before and after a scenario without scraping the log.
func (c *RawController) ServeStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"bytes":   c.wireBytes.Load(),
		"frames":  c.wireFrames.Load(),
		"viewers": c.holder.SubscriberCount(),
	})
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
			if err := writeImagePart(w, frame.Codec, frame.Image); err != nil {
				// The browser went away mid-write; its own context usually
				// reports this too, but a failed write is decisive.
				return
			}
			c.wireBytes.Add(uint64(len(frame.Image)) + mjpegPartOverhead)
			c.wireFrames.Add(1)
			flusher.Flush()
		}
	}
}

// writeImagePart writes one image part and its trailing separator, declaring the
// codec the frame actually carries. A browser handed a PNG labelled as a JPEG
// displays nothing at all, so this is not cosmetic.
func writeImagePart(w http.ResponseWriter, codec Codec, image []byte) error {
	if _, err := fmt.Fprintf(w, "--%s\r\nContent-Type: %s\r\nContent-Length: %d\r\n\r\n",
		mjpegBoundary, codec.ContentType(), len(image)); err != nil {
		return err
	}
	if _, err := w.Write(image); err != nil {
		return err
	}

	_, err := w.Write([]byte("\r\n"))
	return err
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
