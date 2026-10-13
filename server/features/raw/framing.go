package raw

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// maxFrameBytes caps a single interposer message. A frame length arrives as a
// plain 32-bit number from another process, so without a cap one corrupt or
// hostile length would make the server allocate gigabytes.
const maxFrameBytes uint32 = 64 << 20

// errFrameTooLarge reports a message length above maxFrameBytes. The link is
// unusable after one, because the remaining bytes can no longer be framed.
var errFrameTooLarge = errors.New("raw link: frame length exceeds the maximum size")

// readFrame reads one length-prefixed message: a big-endian uint32 length
// followed by that many payload bytes.
//
// Reads are stream-oriented, so a message routinely arrives split across
// several reads; io.ReadFull is what makes each half wait for the rest instead
// of treating a partial read as a complete message.
func readFrame(r io.Reader, max uint32) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}

	length := binary.BigEndian.Uint32(header[:])
	if length > max {
		return nil, fmt.Errorf("%w: %d bytes", errFrameTooLarge, length)
	}

	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}

	return payload, nil
}

// writeFrame writes one length-prefixed message in the same frame format
// readFrame expects.
func writeFrame(w io.Writer, payload []byte) error {
	// Length and payload leave in a single write so that nothing can slip
	// between them: the interposer must never see a header without its frame.
	out := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(out, uint32(len(payload)))
	copy(out[4:], payload)

	_, err := w.Write(out)
	return err
}
