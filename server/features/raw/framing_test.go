package raw

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
	"testing/iotest"
)

// chunkReader hands out at most chunk bytes per Read, the way a TCP stream
// splits a message at arbitrary points.
type chunkReader struct {
	data  []byte
	chunk int
}

func (r *chunkReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := r.chunk
	if n > len(p) {
		n = len(p)
	}
	if n > len(r.data) {
		n = len(r.data)
	}
	copy(p, r.data[:n])
	r.data = r.data[n:]
	return n, nil
}

func encodeFrame(payload []byte) []byte {
	out := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(out, uint32(len(payload)))
	copy(out[4:], payload)
	return out
}

func TestReadFrame_ReassemblesSplitReads(t *testing.T) {
	payloads := [][]byte{
		{},
		{0x01},
		{0xff, 0xd8, 0xff}, // JPEG start of image
		bytes.Repeat([]byte{0xab}, 255),
		bytes.Repeat([]byte{0xcd}, 300),
		bytes.Repeat([]byte{0xef}, 70000),
	}

	var stream []byte
	for _, payload := range payloads {
		stream = append(stream, encodeFrame(payload)...)
	}

	readers := map[string]io.Reader{
		"one byte per read":    iotest.OneByteReader(bytes.NewReader(stream)),
		"three bytes per read": &chunkReader{data: stream, chunk: 3},
		"odd chunks":           &chunkReader{data: stream, chunk: 7},
		"whole stream":         bytes.NewReader(stream),
	}

	for name, reader := range readers {
		t.Run(name, func(t *testing.T) {
			for i, want := range payloads {
				got, err := readFrame(reader, maxFrameBytes)
				if err != nil {
					t.Fatalf("frame %d: readFrame returned error: %v", i, err)
				}
				if !bytes.Equal(got, want) {
					t.Fatalf("frame %d: got %d bytes, want %d bytes", i, len(got), len(want))
				}
			}

			if _, err := readFrame(reader, maxFrameBytes); !errors.Is(err, io.EOF) {
				t.Fatalf("expected io.EOF at the end of the stream, got %v", err)
			}
		})
	}
}

func TestReadFrame_Errors(t *testing.T) {
	oversized := make([]byte, 4)
	binary.BigEndian.PutUint32(oversized, maxFrameBytes+1)

	tests := []struct {
		name    string
		stream  []byte
		wantErr error
	}{
		{name: "empty stream", stream: nil, wantErr: io.EOF},
		{name: "truncated length", stream: []byte{0x00, 0x00}, wantErr: io.ErrUnexpectedEOF},
		{name: "truncated payload", stream: encodeFrame([]byte{1, 2, 3})[:5], wantErr: io.ErrUnexpectedEOF},
		{name: "length above the cap", stream: oversized, wantErr: errFrameTooLarge},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			reader := iotest.OneByteReader(bytes.NewReader(tc.stream))
			if _, err := readFrame(reader, maxFrameBytes); !errors.Is(err, tc.wantErr) {
				t.Fatalf("expected %v, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestWriteFrame_PrefixesBigEndianLength(t *testing.T) {
	payload := []byte{0x10, 0x20, 0x30, 0x40, 0x50}

	var buf bytes.Buffer
	if err := writeFrame(&buf, payload); err != nil {
		t.Fatalf("writeFrame returned error: %v", err)
	}

	want := append([]byte{0x00, 0x00, 0x00, 0x05}, payload...)
	if !bytes.Equal(buf.Bytes(), want) {
		t.Fatalf("wrote % x, want % x", buf.Bytes(), want)
	}

	// Whatever writeFrame produces must come back out of readFrame unchanged,
	// including over a reader that splits every header.
	got, err := readFrame(&chunkReader{data: buf.Bytes(), chunk: 1}, maxFrameBytes)
	if err != nil {
		t.Fatalf("readFrame on a written frame returned error: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("round trip returned % x, want % x", got, payload)
	}
}
