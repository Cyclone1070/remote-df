package raw

import "testing"

// The relay decides, per viewer per frame, whether to hand a frame over or throw
// it away. Those decisions were counters only, so a log could say "41 frames were
// lost" and never which ones. This is the record.
func TestEventLogKeepsOrderAndCountsOverflow(t *testing.T) {
	log := NewEventLog(4)

	for i := 0; i < 6; i++ {
		log.Note(ServerFrameOffered, uint64(i), uint32(7), int64(i), 0, 0)
	}

	if got := log.Dropped(); got != 2 {
		t.Fatalf("dropped = %d, want 2 (six records into four slots)", got)
	}

	recs := log.Drain()
	if len(recs) != 4 {
		t.Fatalf("drained %d records, want 4", len(recs))
	}
	// The oldest are the ones lost, so the survivors are the newest, in order.
	for i, r := range recs {
		if r.Seq != uint64(i+2) {
			t.Fatalf("record %d has seq %d, want %d", i, r.Seq, i+2)
		}
	}
}

// A viewer that cannot keep up loses frames; the loss has to name the frame.
func TestSubscriberRecordsFrameItReplaced(t *testing.T) {
	old := serverEvents
	serverEvents = NewEventLog(64)
	defer func() { serverEvents = old }()

	holder := NewFrameHolder()
	sub := holder.Subscribe()
	_ = sub

	holder.Publish([]byte{1})
	holder.Publish([]byte{2})

	var dropped, offered int
	for _, r := range serverEvents.Drain() {
		switch r.Kind {
		case ServerFrameOffered:
			offered++
		case ServerFrameDropped:
			dropped++
		}
	}
	if offered != 2 || dropped != 1 {
		t.Fatalf("offered %d dropped %d, want 2 and 1", offered, dropped)
	}
}
