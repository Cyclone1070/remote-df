package raw

import "encoding/binary"

// jpegDimensions reads the picture size out of the start-of-frame marker of a
// JPEG image. The size is only shown in the QA overlay, so a stream whose
// header cannot be understood is reported as "size unknown" rather than
// rejected: the raw baseline exists to show what the interposer actually sent.
func jpegDimensions(data []byte) (int, int, bool) {
	if len(data) < 4 || data[0] != 0xff || data[1] != 0xd8 {
		return 0, 0, false
	}

	for i := 2; i+1 < len(data); {
		if data[i] != 0xff {
			// A marker must start here; anything else means this is not a JPEG
			// header we can follow.
			return 0, 0, false
		}

		// Any number of 0xff bytes may pad the space before a marker.
		for i < len(data) && data[i] == 0xff {
			i++
		}
		if i >= len(data) {
			return 0, 0, false
		}

		marker := data[i]
		i++

		switch {
		case marker == 0x00:
			return 0, 0, false
		case marker == 0x01 || (marker >= 0xd0 && marker <= 0xd9):
			// TEM, restart markers, SOI and EOI carry no payload.
			continue
		}

		if i+1 >= len(data) {
			return 0, 0, false
		}
		length := int(binary.BigEndian.Uint16(data[i : i+2]))
		if length < 2 || i+length > len(data) {
			return 0, 0, false
		}

		switch marker {
		case 0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf:
			// Segment layout: length, sample precision, height, width.
			if length < 7 {
				return 0, 0, false
			}
			height := int(binary.BigEndian.Uint16(data[i+3 : i+5]))
			width := int(binary.BigEndian.Uint16(data[i+5 : i+7]))
			if width == 0 || height == 0 {
				return 0, 0, false
			}
			return width, height, true
		}

		i += length
	}

	return 0, 0, false
}
