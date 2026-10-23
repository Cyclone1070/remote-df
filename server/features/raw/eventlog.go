package raw

import (
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Event kinds for the relay's own decisions. They share one namespace with the
// interposer's records (which count from 0) and start at 100 so a merged log can
// never confuse a relay decision with a capture.
const (
	ServerFrameOffered     uint8 = 100 // a frame was offered to a viewer; ID is the viewer
	ServerFrameDropped     uint8 = 101 // the viewer still held the previous one
	ServerFrameWritten     uint8 = 102 // a viewer actually took the frame
	ServerSubscriberJoins  uint8 = 103
	ServerSubscriberLeaves uint8 = 104
)

// Record is one decision, in the same shape the interposer writes so the two
// files can be read by one analysis:
//
//	t_us kind seq id a b c
type Record struct {
	At   int64
	Kind uint8
	Seq  uint64
	ID   uint32
	A    int64
	B    int64
	C    int64
}

// EventLog is the relay's ring: fixed capacity, no allocation on the record path,
// oldest dropped (and counted) when it overflows. A viewer that cannot keep up
// produces up to one record per frame per viewer, so this is nowhere near the
// interposer's volume, but it is written the same way so it costs the same.
type EventLog struct {
	mu      sync.Mutex
	buf     []Record
	head    int
	count   int
	dropped atomic.Uint64
}

func NewEventLog(capacity int) *EventLog {
	if capacity < 1 {
		capacity = 1
	}
	return &EventLog{buf: make([]Record, capacity)}
}

// Note records one decision. Callers must not block on I/O here.
func (l *EventLog) Note(kind uint8, seq uint64, id uint32, a, b, c int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.count == len(l.buf) {
		l.dropped.Add(1)
		l.head = (l.head + 1) % len(l.buf)
		l.count--
	}
	l.buf[(l.head+l.count)%len(l.buf)] = Record{
		At: time.Now().UnixMicro(), Kind: kind, Seq: seq, ID: id, A: a, B: b, C: c,
	}
	l.count++
}

// Drain hands back everything held and empties the ring.
func (l *EventLog) Drain() []Record {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Record, 0, l.count)
	for i := 0; i < l.count; i++ {
		out = append(out, l.buf[(l.head+i)%len(l.buf)])
	}
	l.head = 0
	l.count = 0
	return out
}

func (l *EventLog) Dropped() uint64 { return l.dropped.Load() }

// serverEvents is the package's log. It is a variable so tests can swap it, and
// every decision site uses it rather than opening files of its own.
var serverEvents = NewEventLog(1 << 16)

// nextSubscriberID names viewers in the log; it never repeats within a process.
var nextSubscriberID atomic.Uint32

var eventWriterOnce sync.Once

// StartEventWriter drains the ring to a file every 150 ms. Buffered rather than
// written inline for the same reason as the interposer's: the decision path is on
// the frame path, and a synchronous write per frame is a stall waiting to happen.
func StartEventWriter(path string) {
	if path == "" {
		return
	}
	eventWriterOnce.Do(func() {
		f, err := os.Create(path)
		if err != nil {
			return
		}
		go func() {
			for {
				time.Sleep(150 * time.Millisecond)
				recs := serverEvents.Drain()
				if len(recs) == 0 {
					continue
				}
				buf := make([]byte, 0, len(recs)*48)
				for _, r := range recs {
					buf = strconv.AppendInt(buf, r.At, 10)
					buf = append(buf, ' ')
					buf = strconv.AppendUint(buf, uint64(r.Kind), 10)
					buf = append(buf, ' ')
					buf = strconv.AppendUint(buf, r.Seq, 10)
					buf = append(buf, ' ')
					buf = strconv.AppendUint(buf, uint64(r.ID), 10)
					buf = append(buf, ' ')
					buf = strconv.AppendInt(buf, r.A, 10)
					buf = append(buf, ' ')
					buf = strconv.AppendInt(buf, r.B, 10)
					buf = append(buf, ' ')
					buf = strconv.AppendInt(buf, r.C, 10)
					buf = append(buf, '\n')
				}
				_, _ = f.Write(buf)
			}
		}()
	})
}
