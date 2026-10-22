package raw

import (
	_ "embed"
	"net/http"
	"strings"
)

// The page's measurement primitives are the client's, not a second copy of them.
// measure.js is embedded here and spliced into the page's module at serve time,
// and a test fails if the two files ever differ - a bench whose two paths
// disagree about what a freeze is would be worse than no bench.
//
//go:embed measure.js
var measureModule string

// measureMarker is where the embedded module is spliced into the page.
const measureMarker = "//__DF_MEASURE__"

// rawPage is the entire browser side of the raw baseline: one image fed by the
// MJPEG endpoint, one WebSocket for input, and a small overlay so a human can
// tell at a glance whether frames are still arriving.
//
// The page is one literal string on purpose. It has to be served by this Go
// binary directly, with no bundler, no React and no npm dependency, so that the
// baseline keeps working even when the normal client build is broken.
//
// The input encoding below is a copy of client/src/core/protocol.js encodeInput
// and the key table is a copy of translateKey in client/src/core/input.js. They
// are duplicated rather than shared because the baseline must not depend on the
// client build; the byte layout is fixed by the wire protocol, so the copies
// cannot drift apart without the interposer noticing immediately.
const rawPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Remote-DF raw pixel baseline</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    background: #000;
    overflow: hidden;
  }
  #screen {
    display: block;
    width: 100vw;
    height: 100vh;
    object-fit: contain;
    user-select: none;
    -webkit-user-drag: none;
  }
  #hud {
    position: fixed;
    left: 8px;
    bottom: 8px;
    padding: 4px 8px;
    font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace;
    color: #8f8;
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    white-space: pre;
    pointer-events: none;
  }
  #hud.idle { color: #aaa; }
</style>
</head>
<body>
<img id="screen" src="/raw.mjpg" alt="raw frame stream" draggable="false">
<div id="hud" class="idle">waiting for the stream...</div>
<script type="module">
//__DF_MEASURE__
(function () {
  'use strict';

  // Input event types, as defined by the project's wire protocol.
  var MOUSE_MOVE = 1, MOUSE_DOWN = 2, MOUSE_UP = 3, WHEEL = 4, RESIZE = 5, KEY_DOWN = 16, KEY_UP = 17;

  var screen = document.getElementById('screen');
  var hud = document.getElementById('hud');
  var socket = null;
  var socketOpen = false;
  var status = { fps: 0, w: 0, h: 0, frames: 0, viewers: 0, link: false };

  // What the bench reads. One definition of every number it reports.
  //
  //   display  - when the picture on screen became a different picture. There is
  //              no second subscription to the stream here and no timeline taken
  //              from the server: the element that shows the picture is looked
  //              at, and a sample is recorded only when what it shows has
  //              changed. An image fed by multipart/x-mixed-replace fires exactly
  //              one load event, for the first part, and reports neither how many
  //              parts it drew nor when - so looking at it is the only honest
  //              reading available.
  //   latency  - input sent -> the visible change that answered it, tied to the
  //              input's own stamp rather than to a position in a list.
  var bench = {
    path: 'raw',
    startedAt: performance.now(),
    display: [],
    changeMagnitude: [],
    // The ordered log of the inputs this page sent, with a lookup by stamp built
    // from the same records. A Map keyed by the stamp alone cannot hold more
    // inputs than the stamp space - a 20 s window sends ~380 of them, so two
    // thirds of the window was overwritten before the bench read it. See
    // measure.js's inputLog.
    inputSent: inputLog(),
    latency: [],
    echoes: 0,
    sampled: 0,
    // Coverage: what the page sent, and what came back stamped. The host's own
    // count of the inputs it answered is a different number and is reported
    // next to this one rather than subtracted from it.
    inputsSent: 0,
    stampFramesSeen: 0,
    stampsUnknown: 0,
    // A second echo arriving before the first one was credited: two stamped
    // frames were written inside one display interval, so the display merged
    // them and only the newer one can be credited. Counted because it is the
    // residual ambiguity of pairing an out-of-band announcement with what the
    // element displays.
    echoesOvertaken: 0,
    // The full-resolution verification timeline. See sampleDisplay.
    nativeChanges: [],
    nativeTimes: [],
    nativeSamples: 0,
    nativeCostMs: 0,
    // Which GL stack this browser is actually rendering through. The raw page
    // has no WebGL context of its own, so it asks for a throwaway one: without
    // it the run carries no renderer record at all, and a run with no renderer
    // record cannot be shown to have been taken on hardware GL. Current raw
    // numbers were measured to be renderer-insensitive (86.0 ms SwiftShader
    // against 85.8 ms Metal), so this is record-keeping and future safety rather
    // than a correction of them - see docs/bench.md.
    glRenderer: glRendererReport(),
  };
  // The page's own main thread, as long tasks. A blocked page cannot receive a
  // part or repaint, so a display gap during one is not evidence about the link
  // - and from the page alone the two are indistinguishable.
  bench.longTasks = [];
  try {
    new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        bench.longTasks.push([+entries[i].startTime.toFixed(1), +entries[i].duration.toFixed(1)]);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { /* not exposed here; the bench then reports the gap unattributed */ }
  window.__dfBench = bench;

  function renderHud() {
    var size = (status.w > 0 && status.h > 0) ? status.w + 'x' + status.h : 'no frames';
    var text = status.fps.toFixed(1) + ' fps   ' + size +
      '   frames ' + status.frames +
      '   viewers ' + status.viewers +
      '   interposer ' + (status.link ? 'connected' : 'absent');
    if (!socketOpen) {
      text += '   (input socket reconnecting)';
    }
    hud.textContent = text;
    hud.className = status.frames > 0 ? '' : 'idle';
  }

  // The server pushes {fps, w, h, frames, viewers, link} once a second. The frame rate is
  // measured on the server because an image element fed by
  // multipart/x-mixed-replace reports neither how many frames it drew nor when.
  function connect() {
    var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
    socket = new WebSocket(scheme + location.host + '/raw-input');
    socket.binaryType = 'arraybuffer';

    socket.onopen = function () {
      socketOpen = true;
      renderHud();
      sendResize();
    };
    socket.onclose = function () {
      socketOpen = false;
      renderHud();
      window.setTimeout(connect, 1000);
    };
    socket.onerror = function () {
      if (socket) {
        socket.close();
      }
    };
    socket.onmessage = function (event) {
      if (typeof event.data !== 'string') {
        return;
      }
      var update;
      try {
        update = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      if (typeof update.fps === 'number') { status.fps = update.fps; }
      if (typeof update.frames === 'number') { status.frames = update.frames; }
      if (typeof update.viewers === 'number') { status.viewers = update.viewers; }
      if (typeof update.w === 'number') { status.w = update.w; }
      if (typeof update.h === 'number') { status.h = update.h; }
      // The size the frames really are, so the bench can check the window pin
      // instead of assuming it. Two pages that ask for different sizes encode
      // different numbers of pixels, and a comparison between them is then
      // between two different pictures.
      if (status.w > 0 && status.h > 0) { bench.frameSize = { w: status.w, h: status.h }; }
      status.link = !!update.link;

      // "The frame that answers your input has just been written to you."
      // The stamp itself rides the picture stream as a part header, which the
      // element displaying that stream cannot read, so the relay announces it
      // here instead. Only frames whose pixels differ from the previous frame
      // carry a stamp, so this is at most one message per input that visibly
      // did something.
      if (typeof update.echo === 'number') {
        bench.echoes++;
        if (pendingEcho !== null) { bench.echoesOvertaken++; }
        var sentAt = bench.inputSent.get(update.echo);
        if (sentAt !== undefined) {
          bench.stampFramesSeen++;
          pendingEcho = { stamp: update.echo, sentAt: sentAt, at: performance.now(), relayMs: update.t };
        } else {
          // A stamp this page never issued, or one it has already forgotten.
          // Either way it cannot be tied to an input, so it produces no sample.
          bench.stampsUnknown++;
        }
      }

      renderHud();
    };
  }

  function send(buffer) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(buffer);
    }
  }

  // Same 16 byte layout as DFProtocol.encodeInput: type, int16 x, int16 y,
  // uint8 button, uint32 sym, uint32 scancode, uint16 modifiers, all little
  // endian inside the fields.
  // Round-trip timing. A frame that answers an input carries that input's number
  // back, and the interposer only attaches a number to the first frame captured
  // after the input arrived, so a measurement exists only when the input really
  // did cause a redraw. Inputs that change nothing produce no sample at all.
  var nextStamp = 1;
  var pendingStamps = new Map();
  window.__m2pHistory = [];

  // Which messages count as an input the player made. RESIZE is a protocol
  // message from the page, not something the player did, and nothing about it can
  // be answered by a picture, so it is not part of the coverage count.
  function stampWanted(type) {
    return type !== RESIZE;
  }

  function encodeInput(type, x, y, button, keycode, scancode, mod) {
    if (stampWanted(type)) { bench.inputsSent++; }
    var stamp = nextStamp;
    nextStamp = nextStamp >= 255 ? 1 : nextStamp + 1;
    var sentAt = performance.now();
    pendingStamps.set(stamp, sentAt);
    bench.inputSent.record(stamp, sentAt);
    var buffer = new ArrayBuffer(17);
    var view = new DataView(buffer);
    view.setUint8(0, type);
    view.setInt16(1, x, true);
    view.setInt16(3, y, true);
    view.setUint8(5, button);
    view.setUint32(6, (keycode || 0) >>> 0, true);
    view.setUint32(10, (scancode || 0) >>> 0, true);
    view.setUint16(14, (mod || 0) >>> 0, true);
    view.setUint8(16, stamp);
    return buffer;
  }

  // When the picture on screen became a different picture.
  //
  // There is no second subscription to the stream and no timeline taken from the
  // server. The element that displays the stream reports nothing: it fires one
  // load event for the first part and gives no access to the headers of the
  // parts that follow. So the picture is read back through the element itself at
  // every frame callback and compared with the last reading. A sample is
  // recorded only when the picture really is different, which is the same rule
  // the draw-command path uses.
  //
  // The sample is downscaled: reading 1280x720 back every frame would cost more
  // than the thing being measured. Averaging rather than nearest-neighbour is
  // deliberate - a change smaller than one sample cell still moves the average,
  // so a moving cursor cannot be missed.
  var SAMPLE_W = 256, SAMPLE_H = 144;
  var sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = SAMPLE_W;
  sampleCanvas.height = SAMPLE_H;
  var sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  var detector = new ChangeDetector();
  var previousSample = null;
  var pendingEcho = null;
  var ECHO_MAX_AGE_MS = 1500;

  // The verification pass: the same picture, read back at full resolution, while
  // a stall is suspected.
  //
  // The downscale above is blind to anything smaller than one sample cell - a
  // one-pixel change is lost in the average wherever it lands inside a 5x5 cell,
  // measured at 96% of positions - and a missed change can only lengthen an
  // apparent gap, so it inflates the freeze counts that this bench exists to
  // report. Reading the whole picture back on every frame callback is not an
  // option: measured in this browser, a full-resolution readback plus a hash of
  // it costs 10.4ms, over half a display frame, which would be a bigger
  // perturbation than the error it removes.
  //
  // So it runs when it can matter and not otherwise. The cheap sampler has just
  // failed to see a change for SUSPECT_AFTER_MS, which is the only situation in
  // which its blindness affects a reported number; then the picture is read back
  // at full resolution every NATIVE_EVERY_MS for as long as the suspicion lasts,
  // and any change found is recorded where the bench can reconcile it. On a
  // stream that is moving, this costs nothing at all: at the ~25 changes a second
  // these paths produce, the suspicion never starts.
  //
  // The residual cost is bounded and disclosed rather than assumed away. A
  // readback costs about 11ms on this host and runs at most five times a second
  // while a gap is forming, so it can delay the observation that ENDS a gap by
  // one readback - inside the one-frame bound already quoted with the gap
  // lengths - and it cannot accumulate, because the first change the cheap
  // sampler sees ends the suspicion. The page reports its own total, and the
  // bench prints it with the run.
  //
  // The comparison is exact - the whole buffer, with an early exit - rather than
  // a hash: 3.7M byte comparisons that stop at the first difference, which is
  // cheaper than hashing every byte and cannot miss anything the readback saw.
  // What it still cannot see is a change that appears and is reversed between
  // two checks: that limit is stated wherever the withheld-gap count is printed.
  var SUSPECT_AFTER_MS = 100;
  var NATIVE_EVERY_MS = 200;
  var nativeCanvas = document.createElement('canvas');
  var nativeCtx = nativeCanvas.getContext('2d', { willReadFrequently: true });
  var nativePrev = null;
  var nativeAt = 0;
  var lastCheapChangeAt = 0;

  // Called when the bench starts a measured window, so the first verification
  // sample after it establishes a new baseline instead of comparing against a
  // picture from before the window.
  bench.nativeReset = function () {
    nativePrev = null;
  };

  function nativeSample(at) {
    var w = screen.naturalWidth, h = screen.naturalHeight;
    if (nativeCanvas.width !== w || nativeCanvas.height !== h) {
      nativeCanvas.width = w;
      nativeCanvas.height = h;
      nativePrev = null;
    }
    var started = performance.now();
    nativeCtx.drawImage(screen, 0, 0);
    // Display timestamp for the bench. Without it this page reports no displayed
    // pictures at all, so every pixel row was withheld as "[NO MOVEMENT]" - the
    // bench was not failing to see movement, the page was never saying anything.
    // Same shape and same clock as the instruction page, so the two are
    // comparable without a translation step.
    if (window.__dfBench && window.__dfBench.display) {
      window.__dfBench.display.push(performance.now());
      if (window.__dfBench.display.length > 200000) window.__dfBench.display.shift();
    }
    var data = nativeCtx.getImageData(0, 0, w, h).data;
    var changed = false;
    if (nativePrev === null || nativePrev.length !== data.length) {
      // The first look has nothing to be different from.
      nativePrev = data;
    } else {
      for (var i = 0; i < data.length; i++) {
        if (data[i] !== nativePrev[i]) { changed = true; break; }
      }
      nativePrev = data;
    }
    if (changed) { bench.nativeChanges.push(at); }
    bench.nativeTimes.push(at);
    bench.nativeSamples++;
    bench.nativeCostMs += performance.now() - started;
  }

  function sampleDisplay() {
    if (screen.naturalWidth > 0 && screen.naturalHeight > 0) {
      try {
        sampleCtx.drawImage(screen, 0, 0, SAMPLE_W, SAMPLE_H);
        var pixels = sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
        var hash = viewHash(pixels);
        bench.sampled++;
        var at = performance.now();
        // Verify only while the cheap sampler is in the situation where its
        // blindness could matter: it has not seen a change for a while, so any
        // gap now forming is one the bench would report.
        if (at - lastCheapChangeAt >= SUSPECT_AFTER_MS && at - nativeAt >= NATIVE_EVERY_MS) {
          nativeAt = at;
          nativeSample(at);
        }
        if (detector.observe(hash, at)) {
          lastCheapChangeAt = at;
          bench.display.push(at);
          // How much of the picture changed, not just whether it did. Water
          // animates in this game without anyone touching it, so "something
          // changed" is not evidence that an input did something - the size of
          // the change is.
          bench.changeMagnitude.push(previousSample ? changeMagnitude(previousSample, pixels) : 0);
          previousSample = new Uint8ClampedArray(pixels);
          // The answering frame is the first thing this stream shows after the
          // relay announced it. That is only true because the relay writes the
          // announcement BEFORE it releases the frame's bytes: announced first,
          // the frame cannot be displayed before the page knows which input it
          // answered - which is what used to happen, and what credited the next
          // frame instead (19 of 226 echoes in the measured run, each sample
          // overstated by about one frame interval).
          //
          // An echo that has aged out is dropped rather than credited: a stamp
          // that old is a missing answer, not a slow one.
          if (pendingEcho !== null && at - pendingEcho.at > ECHO_MAX_AGE_MS) { pendingEcho = null; }
          if (pendingEcho !== null && at >= pendingEcho.at) {
            var sample = attributePaint({
              stamp: pendingEcho.stamp,
              sentAt: pendingEcho.sentAt,
              now: at,
              paintChanged: true,
              maxAgeMs: ECHO_MAX_AGE_MS,
            });
            if (sample) bench.latency.push(sample);
            pendingEcho = null;
          }
        }
      } catch (error) { /* an unreadable surface is not a measurement */ }
    }
    window.__dfBench = window.__dfBench || { display: [], paints: 0, framesApplied: 0 };
  window.__dfBench.glRenderer = 'pixel-path';
  window.requestAnimationFrame(sampleDisplay);
  }
  window.requestAnimationFrame(sampleDisplay);

  function modMask(event) {
    var mod = 0;
    if (event.shiftKey) { mod |= 1; }
    if (event.ctrlKey) { mod |= 2; }
    if (event.altKey) { mod |= 4; }
    if (event.metaKey) { mod |= 8; }
    return mod;
  }

  // Frame coordinates, not element coordinates: object-fit contain letterboxes
  // the picture, so the drawn area has to be mapped back onto frame pixels.
  function framePoint(event) {
    var rect = screen.getBoundingClientRect();
    var width = screen.naturalWidth || rect.width || 1;
    var height = screen.naturalHeight || rect.height || 1;
    var scale = Math.min(rect.width / width, rect.height / height) || 1;
    var left = rect.left + (rect.width - width * scale) / 2;
    var top = rect.top + (rect.height - height * scale) / 2;

    var x = Math.round((event.clientX - left) / scale);
    var y = Math.round((event.clientY - top) / scale);

    return {
      x: Math.max(0, Math.min(width - 1, x)),
      y: Math.max(0, Math.min(height - 1, y))
    };
  }

  function buttonNumber(event) {
    if (event.button === 0) { return 1; }
    if (event.button === 1) { return 2; }
    if (event.button === 2) { return 3; }
    return event.button + 1;
  }

  function sendResize() {
    send(encodeInput(RESIZE, window.innerWidth, window.innerHeight, 0, 0, 0, 0));
  }

  // Mouse moves are coalesced onto animation frames: a 1000 Hz mouse would
  // otherwise flood the interposer with events it can never use.
  var pendingMove = null;
  var lastMove = { x: -1, y: -1 };
  var moveScheduled = false;

  function flushMove() {
    moveScheduled = false;
    if (!pendingMove) {
      return;
    }
    if (pendingMove.x !== lastMove.x || pendingMove.y !== lastMove.y) {
      lastMove = pendingMove;
      send(encodeInput(MOUSE_MOVE, pendingMove.x, pendingMove.y, 0, 0, 0, 0));
    }
    pendingMove = null;
  }

  screen.addEventListener('mousemove', function (event) {
    pendingMove = framePoint(event);
    if (!moveScheduled) {
      moveScheduled = true;
      window.requestAnimationFrame(flushMove);
    }
  });

  screen.addEventListener('mousedown', function (event) {
    var point = framePoint(event);
    lastMove = point;
    pendingMove = null;
    send(encodeInput(MOUSE_DOWN, point.x, point.y, buttonNumber(event), 0, 0, modMask(event)));
  });

  screen.addEventListener('mouseup', function (event) {
    var point = framePoint(event);
    lastMove = point;
    pendingMove = null;
    send(encodeInput(MOUSE_UP, point.x, point.y, buttonNumber(event), 0, 0, modMask(event)));
  });

  // A trackpad two-finger tap arrives as a context menu without a matching
  // mouse down, so it is turned into a press and release the way the React
  // client does.
  var lastRightDown = 0;
  screen.addEventListener('contextmenu', function (event) {
    event.preventDefault();
    var now = window.performance.now();
    if (now - lastRightDown > 150) {
      lastRightDown = now;
      var point = framePoint(event);
      send(encodeInput(MOUSE_DOWN, point.x, point.y, 3, 0, 0, 0));
      send(encodeInput(MOUSE_UP, point.x, point.y, 3, 0, 0, 0));
    }
  });

  // One wheel event becomes one notch, up or down. The React client separately
  // classifies physical wheels against trackpads; the baseline only needs the
  // wheel to reach the game.
  screen.addEventListener('wheel', function (event) {
    event.preventDefault();
    var point = framePoint(event);
    var delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
    if (delta === 0) {
      return;
    }
    send(encodeInput(WHEEL, point.x, point.y, delta > 0 ? 2 : 1, 0, 0, modMask(event)));
  }, { passive: false });

  // Key table copied from translateKey in the React client, so the interposer
  // receives the same scancodes and symbols from either page.
  var KEY_MAP = {
    'Enter': { scancode: 40, sym: 13 },
    'NumpadEnter': { scancode: 88, sym: 1073741912 },
    'Numpad0': { scancode: 98, sym: 1073741922 },
    'Numpad1': { scancode: 89, sym: 1073741913 },
    'Numpad2': { scancode: 90, sym: 1073741914 },
    'Numpad3': { scancode: 91, sym: 1073741915 },
    'Numpad4': { scancode: 92, sym: 1073741916 },
    'Numpad5': { scancode: 93, sym: 1073741917 },
    'Numpad6': { scancode: 94, sym: 1073741918 },
    'Numpad7': { scancode: 95, sym: 1073741919 },
    'Numpad8': { scancode: 96, sym: 1073741920 },
    'Numpad9': { scancode: 97, sym: 1073741921 },
    'NumpadDecimal': { scancode: 99, sym: 1073741923 },
    'NumpadDivide': { scancode: 84, sym: 1073741908 },
    'NumpadMultiply': { scancode: 85, sym: 1073741909 },
    'NumpadSubtract': { scancode: 86, sym: 1073741910 },
    'NumpadAdd': { scancode: 87, sym: 1073741911 },
    'NumpadEqual': { scancode: 103, sym: 1073741927 },
    'Escape': { scancode: 41, sym: 27 },
    'Backspace': { scancode: 42, sym: 8 },
    'Tab': { scancode: 43, sym: 9 },
    'Space': { scancode: 44, sym: 32 },
    'Delete': { scancode: 76, sym: 127 },
    'Insert': { scancode: 73, sym: 1073741897 },
    'Home': { scancode: 74, sym: 1073741898 },
    'End': { scancode: 77, sym: 1073741901 },
    'PageUp': { scancode: 75, sym: 1073741899 },
    'PageDown': { scancode: 78, sym: 1073741902 },
    'ArrowRight': { scancode: 79, sym: 1073741903 },
    'ArrowLeft': { scancode: 80, sym: 1073741904 },
    'ArrowDown': { scancode: 81, sym: 1073741905 },
    'ArrowUp': { scancode: 82, sym: 1073741906 },
    'ShiftLeft': { scancode: 225, sym: 1073742049 },
    'ShiftRight': { scancode: 229, sym: 1073742053 },
    'ControlLeft': { scancode: 224, sym: 1073742048 },
    'ControlRight': { scancode: 228, sym: 1073742052 },
    'AltLeft': { scancode: 226, sym: 1073742050 },
    'AltRight': { scancode: 230, sym: 1073742054 },
    'MetaLeft': { scancode: 227, sym: 1073742051 },
    'MetaRight': { scancode: 231, sym: 1073742055 },
    'F1': { scancode: 58, sym: 1073741882 },
    'F2': { scancode: 59, sym: 1073741883 },
    'F3': { scancode: 60, sym: 1073741884 },
    'F4': { scancode: 61, sym: 1073741885 },
    'F5': { scancode: 62, sym: 1073741886 },
    'F6': { scancode: 63, sym: 1073741887 },
    'F7': { scancode: 64, sym: 1073741888 },
    'F8': { scancode: 65, sym: 1073741889 },
    'F9': { scancode: 66, sym: 1073741890 },
    'F10': { scancode: 67, sym: 1073741891 },
    'F11': { scancode: 68, sym: 1073741892 },
    'F12': { scancode: 69, sym: 1073741893 },
    'F13': { scancode: 104, sym: 1073741928 },
    'F14': { scancode: 105, sym: 1073741929 },
    'F15': { scancode: 106, sym: 1073741930 },
    'F16': { scancode: 107, sym: 1073741931 },
    'F17': { scancode: 108, sym: 1073741932 },
    'F18': { scancode: 109, sym: 1073741933 },
    'F19': { scancode: 110, sym: 1073741934 },
    'F20': { scancode: 111, sym: 1073741935 },
    'F21': { scancode: 112, sym: 1073741936 },
    'F22': { scancode: 113, sym: 1073741937 },
    'F23': { scancode: 114, sym: 1073741938 },
    'F24': { scancode: 115, sym: 1073741939 },
    'CapsLock': { scancode: 57, sym: 1073741881 },
    'ScrollLock': { scancode: 71, sym: 1073741895 },
    'NumLock': { scancode: 83, sym: 1073741907 },
    'PrintScreen': { scancode: 70, sym: 1073741894 },
    'Pause': { scancode: 72, sym: 1073741896 },
    'ContextMenu': { scancode: 101, sym: 1073741925 },
    'Minus': { scancode: 45, sym: 45 },
    'Equal': { scancode: 46, sym: 61 },
    'BracketLeft': { scancode: 47, sym: 91 },
    'BracketRight': { scancode: 48, sym: 93 },
    'Backslash': { scancode: 49, sym: 92 },
    'Semicolon': { scancode: 51, sym: 59 },
    'Quote': { scancode: 52, sym: 39 },
    'Backquote': { scancode: 53, sym: 96 },
    'Comma': { scancode: 54, sym: 44 },
    'Period': { scancode: 55, sym: 46 },
    'Slash': { scancode: 56, sym: 47 }
  };

  function translateKey(code, key) {
    if (KEY_MAP[code]) {
      return KEY_MAP[code];
    }

    if (code.indexOf('Key') === 0 && code.length === 4) {
      var letter = code.charCodeAt(3);
      if (letter >= 65 && letter <= 90) {
        return { scancode: 4 + (letter - 65), sym: 97 + (letter - 65) };
      }
    }

    if (code.indexOf('Digit') === 0 && code.length === 6) {
      var digit = code.charCodeAt(5);
      if (digit >= 49 && digit <= 57) {
        return { scancode: 30 + (digit - 49), sym: digit };
      }
      if (digit === 48) {
        return { scancode: 39, sym: 48 };
      }
    }

    if (key && key.length === 1) {
      return { scancode: 0, sym: key.toLowerCase().charCodeAt(0) };
    }

    return null;
  }

  function onKey(event, type) {
    var code = translateKey(event.code, event.key);
    if (!code) {
      return;
    }
    event.preventDefault();
    send(encodeInput(type, 0, 0, 0, code.sym, code.scancode, modMask(event)));
  }

  window.addEventListener('keydown', function (event) {
    onKey(event, KEY_DOWN);
  });
  window.addEventListener('keyup', function (event) {
    onKey(event, KEY_UP);
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(sendResize, 100);
  });

  renderHud();
  connect();
})();
</script>
</body>
</html>
`

// ServePage serves the baseline's single page. Everything the page needs comes
// from the two other routes on this port, so nothing here can affect the main
// UI or its assets.
func (c *RawController) ServePage(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}

	// The measurement module is spliced in rather than fetched, so the page stays
	// a single response with no import graph and so both paths provably compute a
	// freeze the same way.
	page := strings.Replace(rawPage, measureMarker, measureModule, 1)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(page))
}
