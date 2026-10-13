package raw

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// A viewer that is not currently reading must end up holding the newest frame
// and nothing else, however many frames piled up behind it.
func TestSubscriber_KeepsOnlyNewestFrame(t *testing.T) {
	holder := NewFrameHolder()
	sub := holder.Subscribe()
	defer holder.Unsubscribe(sub)

	for i := 1; i <= 5; i++ {
		holder.Publish([]byte{byte(i)})
	}

	select {
	case frame := <-sub.Frames():
		if frame.Seq != 5 {
			t.Errorf("expected the newest frame (seq 5), got seq %d", frame.Seq)
		}
	case <-time.After(time.Second):
		t.Fatalf("subscriber never received a frame")
	}

	select {
	case stale := <-sub.Frames():
		t.Errorf("expected no backlog, but a second frame (seq %d) was waiting", stale.Seq)
	default:
	}
}

// One reader, many writers: the reader must only ever see frames that were
// really published, and it must catch up with the newest frame afterwards
// rather than working through a backlog.
func TestSubscriber_ReaderCatchesUpWithNewestFrame(t *testing.T) {
	holder := NewFrameHolder()
	sub := holder.Subscribe()

	const writers = 4
	const perWriter = 300
	total := uint64(writers * perWriter)

	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				holder.Publish([]byte(fmt.Sprintf("w%d-%d", w, i)))
			}
		}(w)
	}

	// The reader is deliberately slower than the writers: it only records the
	// frames it manages to take.
	observed := make(chan Frame, 1)
	go func() {
		previous := uint64(0)
		for frame := range sub.Frames() {
			if frame.Seq <= previous {
				t.Errorf("frame sequence did not advance: %d after %d", frame.Seq, previous)
				return
			}
			payload := string(frame.Image)
			if !strings.HasPrefix(payload, "w") && payload != "sentinel" {
				t.Errorf("torn frame %d carries payload %q", frame.Seq, payload)
				return
			}
			previous = frame.Seq

			// Blocking send on purpose: the test body drains this channel, so
			// the reader cannot lose the frame it saw last.
			observed <- frame
		}
	}()

	wg.Wait()
	holder.Publish([]byte("sentinel"))

	deadline := time.After(5 * time.Second)
	for {
		select {
		case frame := <-observed:
			if frame.Seq != total+1 {
				continue
			}
			if string(frame.Image) != "sentinel" {
				t.Fatalf("newest frame %d carries payload %q", frame.Seq, frame.Image)
			}
			holder.Unsubscribe(sub)
			return
		case <-deadline:
			t.Fatalf("reader never caught up with the frame published last")
		}
	}
}
