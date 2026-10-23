package raw

import (
	"sync"
	"sync/atomic"
)

// Frame is one complete picture as the interposer delivered it, together with
// the codec that produced it. Seq counts published frames, so callers derive a
// frame rate from successive samples and can tell a fresh frame from a repeat
// without comparing bytes.
type Frame struct {
	Image []byte
	Codec Codec
	// Stamp is the client's own number for the input this frame answers, echoed
	// back so the client can time its own round trip. Zero means the frame
	// answers nothing in particular, which is most of them.
	Stamp  uint8
	Seq    uint64
	Width  int
	Height int
}

// Subscriber is one viewer of the frame stream. Its channel holds at most one
// frame, so a viewer that cannot keep up loses intermediate frames instead of
// building a backlog, and the producer never waits for it.
type Subscriber struct {
	frames chan Frame
	// id names this viewer in the event log, so "which viewer lost the frame"
	// has an answer.
	id uint32
	// offered counts every frame this viewer was given the chance to receive;
	// replaced counts the ones thrown away because its slot still held an older
	// frame. Without these a slow viewer looks identical to a fast one in the
	// counters, and the pixel path's losses are invisible.
	offered  atomic.Uint64
	replaced atomic.Uint64
}

// Delivered reports how many frames were offered to this viewer.
func (s *Subscriber) Delivered() uint64 { return s.offered.Load() }

// Replaced reports how many frames were dropped because the viewer had not yet
// taken the previous one. This is the measure of a viewer falling behind.
func (s *Subscriber) Replaced() uint64 { return s.replaced.Load() }

// Frames exposes the subscriber's frame channel. Whatever arrives on it is the
// newest frame the holder had to give, never a queue of stale ones.
func (s *Subscriber) Frames() <-chan Frame {
	return s.frames
}

// offer places frame into the subscriber's single slot, replacing a stale frame
// that is still waiting there. It never blocks.
func (s *Subscriber) offer(frame Frame) {
	s.offered.Add(1)
	serverEvents.Note(ServerFrameOffered, frame.Seq, s.id, 0, 0, 0)
	select {
	case s.frames <- frame:
		return
	default:
	}

	s.replaced.Add(1)
	if stale, ok := s.takeStale(); ok {
		// Which frame was thrown away, and for which one. A count of replacements
		// cannot say whether the viewer missed one frame or a second of them.
		serverEvents.Note(ServerFrameDropped, stale.Seq, s.id, int64(frame.Seq), 0, 0)
	}

	select {
	case s.frames <- frame:
	default:
	}
}

// FrameHolder keeps the newest complete JPEG frame and fans it out to viewers.
//
// Only the newest frame is ever retained. The raw baseline exists to answer
// "does the interposer produce complete pictures at all", so a frame that is
// already stale by the time it could be delivered is worthless.
type FrameHolder struct {
	mu          sync.Mutex
	latest      Frame
	haveFrame   bool
	count       uint64
	subscribers map[*Subscriber]struct{}
}

// NewFrameHolder creates a holder with no frame and no viewers.
func NewFrameHolder() *FrameHolder {
	return &FrameHolder{subscribers: make(map[*Subscriber]struct{})}
}

// Publish stores a JPEG frame. It is the entry point that predates the baseline
// being able to send anything else, and it stays so callers that only ever have
// a JPEG do not have to name a codec.
func (h *FrameHolder) Publish(jpeg []byte) { h.PublishCodec(CodecJPEG, jpeg) }

// PublishCodec stores image as the newest frame and offers it to every viewer,
// recording which codec produced it so the stream can declare the right content
// type. The caller transfers ownership of the slice. Publishing never blocks,
// which is what stops one slow browser from stalling the interposer's read loop.
func (h *FrameHolder) PublishCodec(codec Codec, image []byte) {
	h.PublishStamped(codec, 0, image)
}

// PublishStamped is PublishCodec with the input stamp the frame is answering.
func (h *FrameHolder) PublishStamped(codec Codec, stamp uint8, image []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.count++

	var width, height int
	if codec == CodecPNG {
		width, height, _ = pngDimensions(image)
	} else {
		width, height, _ = jpegDimensions(image)
	}
	h.latest = Frame{Image: image, Codec: codec, Stamp: stamp, Seq: h.count, Width: width, Height: height}
	h.haveFrame = true

	for sub := range h.subscribers {
		sub.offer(h.latest)
	}
}

// Latest returns the newest frame. The boolean is false until the first frame
// arrives, so callers can show "no video yet" instead of a zero frame.
func (h *FrameHolder) Latest() (Frame, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.latest, h.haveFrame
}

// Subscribe registers a viewer. A viewer that joins between two frames is
// seeded with the current frame so it has something to draw immediately.
func (h *FrameHolder) Subscribe() *Subscriber {
	sub := &Subscriber{frames: make(chan Frame, 1), id: nextSubscriberID.Add(1)}
	serverEvents.Note(ServerSubscriberJoins, 0, sub.id, 0, 0, 0)

	h.mu.Lock()
	defer h.mu.Unlock()

	if h.haveFrame {
		sub.frames <- h.latest
	}
	h.subscribers[sub] = struct{}{}

	return sub
}

// Unsubscribe removes a viewer and closes its channel. Removing the viewer
// under the same lock that Publish holds is what makes closing that channel
// safe: no publish can be in flight against it afterwards.
func (h *FrameHolder) Unsubscribe(sub *Subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if _, ok := h.subscribers[sub]; !ok {
		return
	}
	delete(h.subscribers, sub)
	serverEvents.Note(ServerSubscriberLeaves, 0, sub.id, 0, 0, 0)
	close(sub.frames)
}

// Count reports how many frames have been published, which is how a caller tells
// "the relay is still being fed" from "the relay has viewers but no frames" - two
// states that look identical in every egress counter, because with no viewer
// attached those are all zero.
func (h *FrameHolder) Count() uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.count
}

// SubscriberCount reports how many viewers are attached.
// ViewerCounters sums the delivery counters over every attached viewer. It answers
// the question the pixel path could not previously answer: of the frames the relay
// received, how many were thrown away because a viewer had not taken the previous
// one.
func (h *FrameHolder) ViewerCounters() (delivered, replaced uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.subscribers {
		delivered += sub.Delivered()
		replaced += sub.Replaced()
	}
	return delivered, replaced
}

func (h *FrameHolder) SubscriberCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subscribers)
}

// takeStale removes and returns the frame waiting in a viewer's slot.
func (s *Subscriber) takeStale() (Frame, bool) {
	select {
	case f, ok := <-s.frames:
		return f, ok
	default:
		return Frame{}, false
	}
}
