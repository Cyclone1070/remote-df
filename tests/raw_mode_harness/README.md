# Raw mode local harness

A development-machine harness for the opt-in raw pixel mode in
`interposer/df_streamer.cpp` (DF_RAW_STREAM / `/tmp/df_raw_on`).

It exists because the interposer cannot be built or run here the way the game does:
it includes libdatachannel, which is not installed on the development machine. The
harness supplies the missing pieces so the whole path can be exercised locally -
capture, JPEG encode, framing, send, toggle, input - instead of finding out on the
deploy host that a frame never arrives.

It is NOT part of the deployed build and nothing in `scripts/deploy.sh` reads this
directory. The deploy copies only the four interposer sources it names.

## What it proves

* the mode is inert while it is off: no socket, no worker thread, no readback
* `/tmp/df_raw_on` switches it on in a running process, and removing it switches
  it off again (the link is closed, nothing reconnects, no frames are sent)
* `DF_RAW_STREAM=1` starts it at load time, with no frame presented first, and the
  environment variable wins over the trigger file
* the bytes on the wire are `u32` big-endian length + JPEG, and the JPEG decodes
  back to the frame that was "on screen" (worst channel error is checked, not just
  the markers)
* a framed input message is dispatched through the same handler the WebRTC data
  channel uses
* a server that goes away is reconnected to, and the process neither dies nor
  blocks (`reconnect_test.py`)
* the destructor stops and joins the raw worker instead of leaving a thread behind

## What it does NOT prove

* that it works with the real libdatachannel present: a stub `rtc/rtc.hpp`
  (`tests/stubs/`) provides only the declarations the interposer uses
* that it works on the deploy host's Linux: `dlsym(RTLD_NEXT, ...)` is resolved
  through the caller's link-time dependencies on macOS, so the fake SDL is linked
  in as a dependency here, while on Linux the real SDL2 is found by preload order
* anything about the server side in `server/features/raw/`

## Build and run (from the repo root)

```sh
printf '#include <rtc/rtc.hpp>\nnamespace rtc { void InitLogger(LogLevel) {} }\n' > /tmp/rtc_stub_defs.cpp
cc -dynamiclib -O1 -o /tmp/libfakesdl.dylib tests/raw_mode_harness/fakesdl.c
g++ -shared -fPIC -O1 -std=c++17 -Itests/stubs -I/usr/local/include \
    interposer/df_streamer.cpp /tmp/rtc_stub_defs.cpp \
    -o /tmp/libdf_streamer_test.dylib -lpthread -lzstd -lssl -lcrypto \
    -L/usr/local/lib -ljpeg -L/tmp -lfakesdl -Wl,-rpath,/tmp
g++ -std=c++17 -O1 -Wall -Wextra tests/raw_mode_harness/raw_toggle_harness.cpp \
    -o /tmp/raw_toggle_harness -I/usr/local/include -L/usr/local/lib -ljpeg

# trigger file path
rm -f /tmp/df_raw_on
DYLD_INSERT_LIBRARIES=/tmp/libdf_streamer_test.dylib PORT=18585 \
  DF_RAW_TARGET=127.0.0.1:18492 /tmp/raw_toggle_harness

# environment variable path
DYLD_INSERT_LIBRARIES=/tmp/libdf_streamer_test.dylib PORT=18585 DF_RAW_STREAM=1 \
  DF_RAW_TARGET=127.0.0.1:18492 /tmp/raw_toggle_harness

# server restart while the mode is on
python3 tests/raw_mode_harness/reconnect_test.py &
DYLD_INSERT_LIBRARIES=/tmp/libdf_streamer_test.dylib PORT=18585 DF_RAW_STREAM=1 \
  DF_RAW_TARGET=127.0.0.1:18495 /tmp/raw_toggle_harness
```

`PORT` is set so the WebRTC web server the interposer also starts does not collide
with a real one. Each run ends with `PASS` and exit status 0, or a list of the
checks that failed.

## The JPEG encoder test

`tests/raw_jpeg_test.cpp` is a normal, self-contained test of the encoder alone
(round trip through libjpeg, quality honoured, bad input refused):

```sh
g++ -std=c++17 -O1 -Wall -Wextra -I/usr/local/include tests/raw_jpeg_test.cpp \
    -o /tmp/raw_jpeg_test -L/usr/local/lib -ljpeg && /tmp/raw_jpeg_test
```
