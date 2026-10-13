// End-to-end harness for the opt-in raw pixel mode in interposer/df_streamer.cpp.
//
// The local machine has no libdatachannel, so this cannot run the interposer the
// way the game does. Instead it supplies the missing SDL symbols from a separate
// library (linked as a dependency, because macOS resolves dlsym(RTLD_NEXT, ...)
// through the caller's link-time dependencies) and loads a library built from the
// real interposer source against a stub rtc/rtc.hpp. That makes the whole path
// runnable here: capture, JPEG encode, framing, send, the runtime switch and the
// input direction.
//
// Build (from the repo root) - see tests/raw_mode_harness/README.md:
//   printf '#include <rtc/rtc.hpp>\nnamespace rtc { void InitLogger(LogLevel) {} }\n' > /tmp/rtc_stub_defs.cpp
//   cc -dynamiclib -O1 -o /tmp/libfakesdl.dylib tests/raw_mode_harness/fakesdl.c
//   g++ -shared -fPIC -O1 -std=c++17 -Itests/stubs -I/usr/local/include \
//       interposer/df_streamer.cpp /tmp/rtc_stub_defs.cpp \
//       -o /tmp/libdf_streamer_test.dylib -lpthread -lzstd -lssl -lcrypto \
//       -L/usr/local/lib -ljpeg -L/tmp -lfakesdl -Wl,-rpath,/tmp
//   g++ -std=c++17 -O1 -Wall -Wextra tests/raw_mode_harness/raw_toggle_harness.cpp \
//       -o /tmp/raw_toggle_harness \
//       -I/usr/local/include -L/usr/local/lib -ljpeg
//   DYLD_INSERT_LIBRARIES=/tmp/libdf_streamer_test.dylib PORT=18585 \
//       DF_RAW_TARGET=127.0.0.1:18492 /tmp/raw_toggle_harness

#include <arpa/inet.h>
#include <dlfcn.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

// jpeglib.h needs FILE and size_t to already be in scope, hence the order.
#include <jpeglib.h>

// The fake SDL the interposer's readback ends up in: /tmp/fakesdl.c draws this
// gradient, and this harness checks the decoded JPEG for it.
static const int FAKE_W = 64;
static const int FAKE_H = 48;

static int g_failures = 0;

static void check(bool ok, const char* what) {
    printf("%s %s\n", ok ? "  ok  " : "  FAIL", what);
    if (!ok) g_failures++;
}

static int64_t now_ms() {
    static auto t0 = std::chrono::steady_clock::now();
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - t0).count();
}

static int listen_on(int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons((uint16_t)port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(fd, (struct sockaddr*)&a, sizeof(a)) != 0 || listen(fd, 4) != 0) {
        perror("listen");
        exit(2);
    }
    return fd;
}

static int accept_with_timeout(int lfd, int ms) {
    struct timeval tv;
    tv.tv_sec = ms / 1000;
    tv.tv_usec = (ms % 1000) * 1000;
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(lfd, &rfds);
    if (select(lfd + 1, &rfds, nullptr, nullptr, &tv) <= 0) return -1;
    return accept(lfd, nullptr, nullptr);
}

// Reads one length-prefixed message. Returns 1 on a message, 0 on EOF, -1 on timeout.
static int read_frame(int fd, std::vector<uint8_t>& out, int ms) {
    out.clear();
    uint8_t hdr[4];
    size_t got = 0;
    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
    while (got < 4) {
        auto left = std::chrono::duration_cast<std::chrono::milliseconds>(
            deadline - std::chrono::steady_clock::now()).count();
        if (left <= 0) return -1;
        struct timeval tv;
        tv.tv_sec = left / 1000;
        tv.tv_usec = (left % 1000) * 1000;
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(fd, &rfds);
        int pr = select(fd + 1, &rfds, nullptr, nullptr, &tv);
        if (pr <= 0) return -1;
        ssize_t k = read(fd, hdr + got, 4 - got);
        if (k == 0) return 0;
        if (k < 0) return -1;
        got += (size_t)k;
    }
    uint32_t len = ((uint32_t)hdr[0] << 24) | ((uint32_t)hdr[1] << 16) |
                   ((uint32_t)hdr[2] << 8) | (uint32_t)hdr[3];
    if (len == 0 || len > (64u << 20)) return -1;
    out.resize(len);
    got = 0;
    while (got < len) {
        ssize_t k = read(fd, out.data() + got, len - got);
        if (k == 0) return 0;
        if (k < 0) return -1;
        got += (size_t)k;
    }
    return 1;
}

static void send_all(int fd, const std::vector<uint8_t>& b) {
    size_t off = 0;
    while (off < b.size()) {
        ssize_t k = write(fd, b.data() + off, b.size() - off);
        if (k <= 0) { printf("  send failed\n"); exit(3); }
        off += (size_t)k;
    }
}

static std::vector<uint8_t> framed(const std::vector<uint8_t>& payload) {
    uint32_t len = (uint32_t)payload.size();
    std::vector<uint8_t> out = {(uint8_t)(len >> 24), (uint8_t)(len >> 16), (uint8_t)(len >> 8), (uint8_t)len};
    out.insert(out.end(), payload.begin(), payload.end());
    return out;
}

// Decodes a JPEG and reports the worst channel error against the gradient the fake
// renderer drew. A wrong capture would still produce a valid JPEG; only comparing
// pixels against the frame that was on screen can tell the difference.
static bool decode_and_compare(const std::vector<uint8_t>& jpg, int* w, int* h, int* worst_err) {
    jpeg_decompress_struct cinfo;
    jpeg_error_mgr jerr;
    cinfo.err = jpeg_std_error(&jerr);
    jpeg_create_decompress(&cinfo);
    jpeg_mem_src(&cinfo, jpg.data(), (unsigned long)jpg.size());
    if (jpeg_read_header(&cinfo, TRUE) != JPEG_HEADER_OK) { jpeg_destroy_decompress(&cinfo); return false; }
    jpeg_start_decompress(&cinfo);
    *w = (int)cinfo.output_width;
    *h = (int)cinfo.output_height;
    if (cinfo.output_components != 3 || *w != FAKE_W || *h != FAKE_H) {
        jpeg_destroy_decompress(&cinfo);
        return false;
    }
    std::vector<uint8_t> row((size_t)*w * 3);
    int worst = 0;
    while (cinfo.output_scanline < cinfo.output_height) {
        JSAMPROW rp = row.data();
        jpeg_read_scanlines(&cinfo, &rp, 1);
        int y = (int)cinfo.output_scanline - 1;
        for (int x = 0; x < *w; x++) {
            int want[3] = {x * 4, y * 5, 128};
            for (int c = 0; c < 3; c++) {
                int d = want[c] - (int)row[(size_t)x * 3 + c];
                if (d < 0) d = -d;
                if (d > worst) worst = d;
            }
        }
    }
    jpeg_finish_decompress(&cinfo);
    jpeg_destroy_decompress(&cinfo);
    *worst_err = worst;
    return true;
}

// A viewer that always reads, like the real server does. Without it the socket
// buffer fills, the interposer's bounded send times out and it rebuilds the link -
// correct behaviour, but not what this test is trying to observe.
struct Drain {
    std::atomic<bool> eof{false};
    std::atomic<uint64_t> frames{0};
    std::vector<uint8_t> last;
    std::thread th;

    void start(int fd) {
        th = std::thread([this, fd]() {
            for (;;) {
                std::vector<uint8_t> f;
                int r = read_frame(fd, f, 200);
                if (r == 0) { fprintf(stderr, "[H] drain EOF at %lldms frames=%llu\n", (long long)now_ms(), (unsigned long long)frames.load()); fflush(stderr); eof.store(true); return; }
                if (r < 0) {
                    if (eof.load()) return;
                    continue;   // idle timeout: nothing to do but wait again
                }
                last = f;
                frames++;
                fprintf(stderr, "[H] drain frame %llu (%zu bytes) at %lldms\n", (unsigned long long)frames.load(), f.size(), (long long)now_ms()); fflush(stderr);
            }
        });
    }
    void stop() {
        eof.store(true);
        if (th.joinable()) th.join();
    }
};

// Frames only exist while the game presents, so waiting for the raw stream means
// presenting the way the game does - sleeping would prove nothing.
static void pump(void (*present)(void*), int ms) {
    for (int t = 0; t < ms; t += 50) {
        present(nullptr);
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
}

int main() {
    const int RAW_PORT = 18492;
    setvbuf(stdout, nullptr, _IONBF, 0);
    fprintf(stderr, "[H t=%lldms] main entered\n", (long long)now_ms()); fflush(stderr);
    unlink("/tmp/df_raw_on");

    // The interposer is inserted ahead of everything else, so the first definition
    // of SDL_RenderPresent in the global scope is its hook - the call the game makes.
    auto present = (void (*)(void*))dlsym(RTLD_DEFAULT, "SDL_RenderPresent");
    if (!present) { printf("no SDL_RenderPresent in the global scope\n"); return 1; }

    int lfd = listen_on(RAW_PORT);

    const char* env = getenv("DF_RAW_STREAM");
    if (env && atoi(env) == 1) {
        // The startup path: the worker exists from load time, before any frame is
        // presented, and the environment variable cannot be switched off by a file.
        printf("ENV PATH: DF_RAW_STREAM=1 at startup, no trigger file\n");
        fprintf(stderr, "[H t=%lldms] listener ready on %d, accepting\n", (long long)now_ms(), RAW_PORT); fflush(stderr);
        int efd = accept_with_timeout(lfd, 2000);
        fprintf(stderr, "[H t=%lldms] accept -> %d\n", (long long)now_ms(), efd); fflush(stderr);
        check(efd >= 0, "the worker connects at load time without any present");
        Drain ed;
        if (efd >= 0) ed.start(efd);
        pump(present, 800);
        check(ed.frames.load() >= 3, "frames flow with DF_RAW_STREAM=1");
        unlink("/tmp/df_raw_on");
        pump(present, 1500);
        check(!ed.eof.load(), "the environment variable keeps the mode on with no trigger file");
        ed.stop();
        if (efd >= 0) close(efd);
        close(lfd);
        if (g_failures == 0) printf("\nPASS\n"); else printf("\n%d CHECK(S) FAILED\n", g_failures);
        return g_failures == 0 ? 0 : 1;
    }

    printf("PHASE 1: no trigger file, no env var\n");
    for (int i = 0; i < 5; i++) { present(nullptr); std::this_thread::sleep_for(std::chrono::milliseconds(30)); }
    check(accept_with_timeout(lfd, 300) < 0, "no connection is made while the mode is off");
    check(access("/tmp/df_raw_on", F_OK) != 0, "the trigger file really is absent (control)");

    printf("PHASE 2: trigger file appears at t=%lldms\n", (long long)now_ms());
    FILE* f = fopen("/tmp/df_raw_on", "w");
    if (f) fclose(f);
    int fd = -1;
    for (int i = 0; i < 60 && fd < 0; i++) {
        present(nullptr);
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        fd = accept_with_timeout(lfd, 0);
    }
    fprintf(stderr, "[H] accepted fd=%d at %lldms\n", fd, (long long)now_ms()); fflush(stderr);
    check(fd >= 0, "the worker connects within a second of the file appearing");

    Drain drain;
    if (fd >= 0) drain.start(fd);
    pump(present, 500);
    check(drain.frames.load() >= 3, "frames keep arriving after the first one");

    std::vector<uint8_t> frame = drain.last;
    check(frame.size() > 100 && frame[0] == 0xFF && frame[1] == 0xD8, "the payload starts with the JPEG SOI marker");
    check(frame.size() > 2 && frame[frame.size() - 2] == 0xFF && frame[frame.size() - 1] == 0xD9,
          "the payload ends with the JPEG EOI marker");

    int jw = 0, jh = 0, jerr = 0;
    bool decoded = !frame.empty() && decode_and_compare(frame, &jw, &jh, &jerr);
    check(decoded, "the payload decodes as a JPEG of the captured size");
    if (decoded) {
        printf("  (decoded %dx%d, worst channel error vs the drawn frame: %d)\n", jw, jh, jerr);
        check(jerr <= 12, "the decoded picture is the frame that was on screen");
    }

    // Input on the same socket, through the same handler the WebRTC path uses.
    if (fd >= 0) {
        std::vector<uint8_t> gap = {7, 0, 0, 0, 42};
        send_all(fd, framed(gap));
        std::vector<uint8_t> motion(17, 0);
        motion[0] = 1;
        motion[16] = 3;
        send_all(fd, framed(motion));
        printf("  (sent a 5-byte GAP_ACK and a 17-byte MOUSEMOTION)\n");
    }

    printf("PHASE 3: trigger file removed at t=%lldms\n", (long long)now_ms());
    unlink("/tmp/df_raw_on");
    for (int i = 0; i < 80 && !drain.eof.load(); i++) {
        present(nullptr);
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    check(drain.eof.load(), "the interposer closes the link once the mode is switched off");
    uint64_t at_close = drain.frames.load();
    pump(present, 500);
    check(drain.frames.load() == at_close, "no frames are sent after the switch goes off");
    drain.stop();
    if (fd >= 0) close(fd);
    check(accept_with_timeout(lfd, 400) < 0, "nothing reconnects while the mode is off");

    printf("PHASE 4: trigger file returns at t=%lldms\n", (long long)now_ms());
    f = fopen("/tmp/df_raw_on", "w");
    if (f) fclose(f);
    fd = -1;
    for (int i = 0; i < 60 && fd < 0; i++) {
        present(nullptr);
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        fd = accept_with_timeout(lfd, 0);
    }
    check(fd >= 0, "the same process switches back on without a restart");
    Drain drain2;
    if (fd >= 0) drain2.start(fd);
    pump(present, 600);
    check(drain2.frames.load() >= 3, "frames flow again after switching back on");
    drain2.stop();
    if (fd >= 0) close(fd);
    close(lfd);
    unlink("/tmp/df_raw_on");

    printf("  (the interposer's destructor runs at process exit, after this line)\n");
    if (g_failures == 0) printf("\nPASS\n");
    else printf("\n%d CHECK(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
