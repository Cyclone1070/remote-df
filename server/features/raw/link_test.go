package raw

import (
	"bytes"
	"encoding/binary"
	"errors"
	"net"
	"testing"
	"time"
)

// waitFor polls until condition holds, so tests do not depend on scheduling
// order between the server's goroutines and the test body.
func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func startLinkServer(t *testing.T) (*LinkServer, *FrameHolder, net.Listener) {
	t.Helper()

	holder := NewFrameHolder()
	server := NewLinkServer(holder)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen: %v", err)
	}

	served := make(chan error, 1)
	go func() {
		served <- server.Serve(listener)
	}()

	t.Cleanup(func() {
		_ = server.Close()
		select {
		case err := <-served:
			if err != nil {
				t.Errorf("Serve returned error: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Errorf("Serve did not return after Close")
		}
	})

	return server, holder, listener
}

func dialInterposer(t *testing.T, listener net.Listener) net.Conn {
	t.Helper()

	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})

	return conn
}

func TestLinkServer_PublishesFramesFromInterposer(t *testing.T) {
	server, holder, listener := startLinkServer(t)
	conn := dialInterposer(t, listener)

	first := []byte{0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9}
	second := bytes.Repeat([]byte{0x42}, 4096)

	if _, err := conn.Write(encodeCodecFrame(CodecJPEG, first)); err != nil {
		t.Fatalf("failed to write frame: %v", err)
	}

	// The second frame is written in two halves, with a pause in between, to
	// prove the server waits for a whole frame instead of publishing a partial
	// image.
	framed := encodeCodecFrame(CodecJPEG, second)
	if _, err := conn.Write(framed[:1000]); err != nil {
		t.Fatalf("failed to write frame header: %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	if _, err := conn.Write(framed[1000:]); err != nil {
		t.Fatalf("failed to write frame body: %v", err)
	}

	waitFor(t, "both frames to arrive", func() bool {
		frame, ok := holder.Latest()
		return ok && frame.Seq == 2
	})

	frame, ok := holder.Latest()
	if !ok {
		t.Fatalf("expected a frame in the holder")
	}
	if !bytes.Equal(frame.Image, second) {
		t.Fatalf("newest frame is %d bytes, want the %d-byte second frame", len(frame.Image), len(second))
	}

	if !server.Connected() {
		t.Errorf("expected the interposer connection to be reported as connected")
	}
}

func TestLinkServer_ForwardsInputVerbatim(t *testing.T) {
	server, _, listener := startLinkServer(t)
	conn := dialInterposer(t, listener)

	waitFor(t, "the interposer connection to be accepted", server.Connected)

	// A key-down event exactly as the browser encodes it: type 16, scancode 4
	// (KeyA) and sym 97, padded to the fixed 16 byte layout.
	keyDown := []byte{16, 0, 0, 0, 0, 0, 0x61, 0, 0, 0, 0x04, 0, 0, 0, 0, 0}
	if err := server.SendInput(keyDown); err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}

	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("failed to set read deadline: %v", err)
	}
	got, err := readFrame(conn, maxFrameBytes)
	if err != nil {
		t.Fatalf("interposer failed to read the input frame: %v", err)
	}
	if !bytes.Equal(got, keyDown) {
		t.Fatalf("interposer received % x, want % x", got, keyDown)
	}

	// A second event must arrive after the first, unmixed.
	keyUp := append([]byte{17}, keyDown[1:]...)
	if err := server.SendInput(keyUp); err != nil {
		t.Fatalf("second SendInput returned error: %v", err)
	}
	got, err = readFrame(conn, maxFrameBytes)
	if err != nil {
		t.Fatalf("interposer failed to read the second input frame: %v", err)
	}
	if !bytes.Equal(got, keyUp) {
		t.Fatalf("interposer received % x, want % x", got, keyUp)
	}
}

func TestLinkServer_SendInputWithoutInterposerDoesNotBlock(t *testing.T) {
	server, _, _ := startLinkServer(t)

	done := make(chan error, 1)
	go func() {
		done <- server.SendInput([]byte{16, 0, 0})
	}()

	select {
	case err := <-done:
		if !errors.Is(err, ErrNoInterposer) {
			t.Fatalf("expected ErrNoInterposer, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatalf("SendInput blocked with no interposer connected")
	}
}

func TestLinkServer_DropsConnectionOnOversizedFrame(t *testing.T) {
	server, holder, listener := startLinkServer(t)
	conn := dialInterposer(t, listener)

	waitFor(t, "the interposer connection to be accepted", server.Connected)

	// A length above the cap cannot be framed, so the server must drop the
	// connection rather than allocate it or desynchronise.
	oversized := make([]byte, 4)
	binary.BigEndian.PutUint32(oversized, maxFrameBytes+1)
	if _, err := conn.Write(oversized); err != nil {
		t.Fatalf("failed to write oversized length: %v", err)
	}

	waitFor(t, "the connection to be dropped", func() bool {
		return !server.Connected()
	})

	if frame, ok := holder.Latest(); ok {
		t.Errorf("expected no frame from an oversized length, got frame %d", frame.Seq)
	}

	// The listener must still be usable: a restarted interposer reconnects.
	reconnected := dialInterposer(t, listener)
	if _, err := reconnected.Write(encodeCodecFrame(CodecJPEG, []byte{0xff, 0xd8, 0xff, 0xd9})); err != nil {
		t.Fatalf("failed to write frame after reconnect: %v", err)
	}
	waitFor(t, "a frame from the reconnected interposer", func() bool {
		frame, ok := holder.Latest()
		return ok && frame.Seq == 1
	})
}

// encodeCodecFrame builds a wire frame the way the interposer does: a length, a
// one-byte codec tag, then the picture. The tag is part of the format, so a test
// that omits it is testing a format nothing speaks.
func encodeCodecFrame(codec Codec, image []byte) []byte {
	return encodeFrame(append([]byte{byte(codec)}, image...))
}

// A lossless frame must survive the link with its codec and its size intact. The
// size comes from the PNG header rather than a JPEG marker walk, so this is the
// check that the baseline reports its own dimensions correctly.
func TestLinkServer_PublishesLosslessFramesWithDimensions(t *testing.T) {
	png := buildTestPNG(64, 48)
	_, holder, listener := startLinkServer(t)
	conn := dialInterposer(t, listener)

	if _, err := conn.Write(encodeCodecFrame(CodecPNG, png)); err != nil {
		t.Fatalf("failed to write frame: %v", err)
	}

	waitFor(t, "the lossless frame to arrive", func() bool {
		_, ok := holder.Latest()
		return ok
	})

	frame, _ := holder.Latest()
	if frame.Codec != CodecPNG {
		t.Errorf("codec is %v, want CodecPNG", frame.Codec)
	}
	if !bytes.Equal(frame.Image, png) {
		t.Errorf("stored image differs from what was sent")
	}
	if frame.Width != 64 || frame.Height != 48 {
		t.Errorf("dimensions are %dx%d, want 64x48", frame.Width, frame.Height)
	}
	if frame.Codec.ContentType() != "image/png" {
		t.Errorf("content type is %q, want image/png", frame.Codec.ContentType())
	}
}
