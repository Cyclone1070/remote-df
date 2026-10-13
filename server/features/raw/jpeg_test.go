package raw

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

func encodeTestJPEG(t *testing.T, width, height int) []byte {
	t.Helper()

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 0x80, A: 0xff})
		}
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("failed to encode test jpeg: %v", err)
	}

	return buf.Bytes()
}

// syntheticJPEG builds a header-only JPEG whose start-of-frame marker uses the
// given marker byte, so progressive and unusual streams are covered too.
func syntheticJPEG(marker byte, width, height int, fillBytes int, standalone bool) []byte {
	out := []byte{0xff, 0xd8}

	if standalone {
		// A TEM marker and a restart marker carry no length bytes.
		out = append(out, 0xff, 0x01, 0xff, 0xd0)
	}

	out = append(out, 0xff, 0xe0, 0x00, 0x10)
	out = append(out, []byte("JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")...)

	out = append(out, 0xff)
	for i := 0; i < fillBytes; i++ {
		out = append(out, 0xff)
	}
	out = append(out,
		marker,
		0x00, 0x11, // segment length: 17 bytes
		0x08,                          // sample precision
		byte(height>>8), byte(height), // height
		byte(width>>8), byte(width), // width
		0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
	)
	out = append(out, 0xff, 0xd9)

	return out
}

func TestJPEGDimensions(t *testing.T) {
	real := encodeTestJPEG(t, 64, 48)

	tests := []struct {
		name       string
		data       []byte
		wantWidth  int
		wantHeight int
		wantOK     bool
	}{
		{name: "baseline jpeg", data: real, wantWidth: 64, wantHeight: 48, wantOK: true},
		{name: "progressive frame header", data: syntheticJPEG(0xc2, 320, 240, 0, false), wantWidth: 320, wantHeight: 240, wantOK: true},
		{name: "fill bytes and standalone markers", data: syntheticJPEG(0xc0, 800, 600, 3, true), wantWidth: 800, wantHeight: 600, wantOK: true},
		{name: "not a jpeg", data: []byte("this is not a picture"), wantOK: false},
		{name: "truncated header", data: real[:3], wantOK: false},
		{name: "truncated segment", data: syntheticJPEG(0xc0, 16, 16, 0, false)[:8], wantOK: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			width, height, ok := jpegDimensions(tc.data)
			if ok != tc.wantOK {
				t.Fatalf("ok is %v, want %v", ok, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			if width != tc.wantWidth || height != tc.wantHeight {
				t.Fatalf("got %dx%d, want %dx%d", width, height, tc.wantWidth, tc.wantHeight)
			}
		})
	}
}

func TestFrameHolder_ReportsFrameSize(t *testing.T) {
	holder := NewFrameHolder()

	holder.Publish(encodeTestJPEG(t, 320, 200))
	frame, ok := holder.Latest()
	if !ok {
		t.Fatalf("expected the published frame")
	}
	if frame.Width != 320 || frame.Height != 200 {
		t.Fatalf("frame reports %dx%d, want 320x200", frame.Width, frame.Height)
	}

	// A payload whose header cannot be understood must still be kept: the raw
	// baseline shows what the interposer sent, parsed or not.
	holder.Publish([]byte("garbage"))
	frame, ok = holder.Latest()
	if !ok {
		t.Fatalf("expected the published frame")
	}
	if frame.Width != 0 || frame.Height != 0 {
		t.Errorf("unparseable frame reports %dx%d, want 0x0", frame.Width, frame.Height)
	}
	if string(frame.Image) != "garbage" {
		t.Errorf("holder stored %q, want the raw payload", frame.Image)
	}
}
