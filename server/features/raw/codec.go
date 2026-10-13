package raw

import "encoding/binary"

// Codec names how the picture in a frame was produced. The interposer tags every
// frame with one so the receiver never has to guess from the bytes: a JPEG and a
// PNG are both opaque blobs and sniffing them is the kind of guess that fails
// silently, leaving a blank screen with no error anywhere.
type Codec uint8

const (
	// CodecJPEG is lossy. Any quality setting is an approximation of what the
	// game drew, so frames carrying it are not a fair size comparison against a
	// path that sends its pictures bit-exact.
	CodecJPEG Codec = 0
	// CodecPNG is lossless: the pixels the game made, compressed without loss.
	CodecPNG Codec = 1
)

// ContentType is what a frame of this codec should be declared as on the wire.
func (c Codec) ContentType() string {
	if c == CodecPNG {
		return "image/png"
	}
	return "image/jpeg"
}

// Known reports whether the tag is one this build understands. An unknown tag
// means the two ends disagree about the protocol, which is worth refusing.
func (c Codec) Known() bool { return c == CodecJPEG || c == CodecPNG }

// pngDimensions reads the size from the IHDR chunk. PNG puts it at a fixed
// offset, unlike JPEG where it hides behind a walk of the marker segments.
func pngDimensions(data []byte) (int, int, bool) {
	sig := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}
	if len(data) < 24 || string(data[:8]) != string(sig) {
		return 0, 0, false
	}
	// The first chunk must be IHDR: length, type, then width and height.
	if string(data[12:16]) != "IHDR" {
		return 0, 0, false
	}
	width := int(binary.BigEndian.Uint32(data[16:20]))
	height := int(binary.BigEndian.Uint32(data[20:24]))
	if width <= 0 || height <= 0 {
		return 0, 0, false
	}
	return width, height, true
}
