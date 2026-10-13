package raw

import "net/http"

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
<script>
(function () {
  'use strict';

  // Input event types, as defined by the project's wire protocol.
  var MOUSE_MOVE = 1, MOUSE_DOWN = 2, MOUSE_UP = 3, WHEEL = 4, RESIZE = 5, KEY_DOWN = 16, KEY_UP = 17;

  var screen = document.getElementById('screen');
  var hud = document.getElementById('hud');
  var socket = null;
  var socketOpen = false;
  var status = { fps: 0, w: 0, h: 0, frames: 0, viewers: 0, link: false };

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
      status.link = !!update.link;
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
  function encodeInput(type, x, y, button, keycode, scancode, mod) {
    var buffer = new ArrayBuffer(16);
    var view = new DataView(buffer);
    view.setUint8(0, type);
    view.setInt16(1, x, true);
    view.setInt16(3, y, true);
    view.setUint8(5, button);
    view.setUint32(6, (keycode || 0) >>> 0, true);
    view.setUint32(10, (scancode || 0) >>> 0, true);
    view.setUint16(14, (mod || 0) >>> 0, true);
    return buffer;
  }

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

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(rawPage))
}
