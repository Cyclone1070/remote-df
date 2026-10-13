package raw

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"hash/crc32"
	"testing"
)

// buildTestPNG makes a real, valid PNG so the dimension reader is exercised
// against the format rather than against a hand-picked byte string.
func buildTestPNG(w, h int) []byte {
	var out bytes.Buffer
	out.Write([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})

	chunk := func(typ string, data []byte) {
		var n [4]byte
		binary.BigEndian.PutUint32(n[:], uint32(len(data)))
		out.Write(n[:])
		body := append([]byte(typ), data...)
		out.Write(body)
		var c [4]byte
		binary.BigEndian.PutUint32(c[:], crc32.ChecksumIEEE(body))
		out.Write(c[:])
	}

	var ihdr [13]byte
	binary.BigEndian.PutUint32(ihdr[0:4], uint32(w))
	binary.BigEndian.PutUint32(ihdr[4:8], uint32(h))
	ihdr[8] = 8
	ihdr[9] = 6
	chunk("IHDR", ihdr[:])

	raw := make([]byte, 0, h*(w*4+1))
	for y := 0; y < h; y++ {
		raw = append(raw, 0)
		raw = append(raw, bytes.Repeat([]byte{0x40, 0x80, 0xc0, 0xff}, w)...)
	}
	var z bytes.Buffer
	zw := zlib.NewWriter(&z)
	_, _ = zw.Write(raw)
	_ = zw.Close()
	chunk("IDAT", z.Bytes())
	chunk("IEND", nil)
	return out.Bytes()
}

func TestPNGDimensions(t *testing.T) {
	cases := []struct {
		name string
		w, h int
	}{
		{"square", 192, 192},
		{"wide", 1280, 720},
		{"odd", 33, 17},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w, h, ok := pngDimensions(buildTestPNG(tc.w, tc.h))
			if !ok {
				t.Fatalf("dimensions not read")
			}
			if w != tc.w || h != tc.h {
				t.Errorf("got %dx%d, want %dx%d", w, h, tc.w, tc.h)
			}
		})
	}
}

func TestPNGDimensionsRejectsRubbish(t *testing.T) {
	if _, _, ok := pngDimensions(nil); ok {
		t.Error("accepted an empty buffer")
	}
	if _, _, ok := pngDimensions([]byte("not a picture at all, just text")); ok {
		t.Error("accepted text")
	}
	if _, _, ok := pngDimensions([]byte{0xff, 0xd8, 0xff, 0xe0, 0, 16, 'J', 'F', 'I', 'F'}); ok {
		t.Error("accepted a JPEG")
	}
	// A PNG whose IHDR is not first is malformed and must be refused.
	bad := buildTestPNG(8, 8)
	copy(bad[12:16], "IDAT")
	if _, _, ok := pngDimensions(bad); ok {
		t.Error("accepted a PNG without a leading IHDR")
	}
}

func TestCodecContentType(t *testing.T) {
	if got := CodecJPEG.ContentType(); got != "image/jpeg" {
		t.Errorf("jpeg content type is %q", got)
	}
	if got := CodecPNG.ContentType(); got != "image/png" {
		t.Errorf("png content type is %q", got)
	}
	if !CodecJPEG.Known() || !CodecPNG.Known() {
		t.Error("a codec this build defines was reported unknown")
	}
	if Codec(7).Known() {
		t.Error("an undefined codec was reported known")
	}
}
