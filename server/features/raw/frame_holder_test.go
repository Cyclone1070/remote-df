package raw

import (
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestFrameHolder_LatestReturnsNewestFrame(t *testing.T) {
	holder := NewFrameHolder()

	if _, ok := holder.Latest(); ok {
		t.Fatalf("expected no frame before the first publish")
	}

	for i := 1; i <= 3; i++ {
		holder.Publish([]byte{byte(i)})
	}

	frame, ok := holder.Latest()
	if !ok {
		t.Fatalf("expected a frame after publishing")
	}
	if frame.Seq != 3 {
		t.Errorf("expected sequence 3, got %d", frame.Seq)
	}
	if len(frame.Image) != 1 || frame.Image[0] != 3 {
		t.Errorf("expected the newest payload [3], got %v", frame.Image)
	}
	if frame.Seq != 3 {
		t.Errorf("expected 3 published frames, got seq %d", frame.Seq)
	}
}

// A stalled reader must never apply back pressure: the interposer keeps
// producing frames whether or not anybody is watching.
func TestFrameHolder_ConcurrentWritersNeverBlock(t *testing.T) {
	holder := NewFrameHolder()

	// This subscriber is deliberately never drained.
	sub := holder.Subscribe()
	defer holder.Unsubscribe(sub)

	const writers = 8
	const perWriter = 500

	var next uint64
	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				n := atomic.AddUint64(&next, 1)
				holder.Publish([]byte(strconv.FormatUint(n, 10)))
			}
		}()
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatalf("publishers blocked; the holder must drop frames instead of waiting on readers")
	}

	// No publish may be lost, so the sequence must have advanced exactly once
	// per frame, and the newest frame must sit at the top of that range.
	total := uint64(writers * perWriter)
	frame, ok := holder.Latest()
	if !ok {
		t.Fatalf("expected a frame after concurrent publishing")
	}
	if frame.Seq != total {
		t.Errorf("expected every publish to advance the sequence to %d, got %d", total, frame.Seq)
	}

	// The payload is one of the values the writers produced. Anything else
	// means a frame was torn or paired with the wrong sequence.
	n, err := strconv.ParseUint(string(frame.Image), 10, 64)
	if err != nil || n == 0 || n > total {
		t.Errorf("latest frame carries payload %q, which no writer produced", frame.Image)
	}
}
