package raw

import "sync"

// Frame is one complete picture as the interposer delivered it, together with
// the codec that produced it. Seq counts published frames, so callers derive a
// frame rate from successive samples and can tell a fresh frame from a repeat
// without comparing bytes.
type Frame struct {
	Image  []byte
	Codec  Codec
	Seq    uint64
	Width  int
	Height int
}


// Subscriber is one viewer of the frame stream. Its channel holds at most one
// frame, so a viewer that cannot keep up loses intermediate frames instead of
// building a backlog, and the producer never waits for it.
type Subscriber struct {
	frames chan Frame
}

// Frames exposes the subscriber's frame channel. Whatever arrives on it is the
// newest frame the holder had to give, never a queue of stale ones.
func (s *Subscriber) Frames() <-chan Frame {
	return s.frames
}

// offer places frame into the subscriber's single slot, replacing a stale frame
// that is still waiting there. It never blocks.
func (s *Subscriber) offer(frame Frame) {
	select {
	case s.frames <- frame:
		return
	default:
	}

	// Slot full: the waiting frame is already out of date, so drop it.
	select {
	case <-s.frames:
	default:
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
	h.mu.Lock()
	defer h.mu.Unlock()

	h.count++

	var width, height int
	if codec == CodecPNG {
		width, height, _ = pngDimensions(image)
	} else {
		width, height, _ = jpegDimensions(image)
	}
	h.latest = Frame{Image: image, Codec: codec, Seq: h.count, Width: width, Height: height}
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
	sub := &Subscriber{frames: make(chan Frame, 1)}

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
	close(sub.frames)
}

// SubscriberCount reports how many viewers are attached.
func (h *FrameHolder) SubscriberCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subscribers)
}
