package web

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
)

func TestRegisterStreamProxy(t *testing.T) {
	// 1. Mock internal stream server
	received := false
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" {
			received = true
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("stream-backend-ok"))
		}
	}))
	defer backend.Close()

	u, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatalf("failed to parse backend url: %v", err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("failed to parse backend port: %v", err)
	}

	// 2. Register proxy on mux
	mux := http.NewServeMux()
	RegisterStreamProxy(mux, port)

	// 3. Make request to /ws
	req := httptest.NewRequest("GET", "/ws", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	// 4. Assert
	if !received {
		t.Fatalf("expected request to be forwarded to backend /ws")
	}
	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}
	if w.Body.String() != "stream-backend-ok" {
		t.Fatalf("unexpected response body: %s", w.Body.String())
	}
}

// The streamer's own counters are served by the streamer, and this server is the
// only way to reach it from outside the container. Without the proxy the bench
// would have to scrape the streamer's log, which is a second, different number
// pretending to be the same one.
func TestStreamProxy_ServesTheStreamersCounters(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/df-stats" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"wireBytes":123}`))
	}))
	defer backend.Close()

	u, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatalf("failed to parse backend url: %v", err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("failed to parse backend port: %v", err)
	}

	mux := http.NewServeMux()
	RegisterStreamProxy(mux, port)

	req := httptest.NewRequest("GET", "/df-stats", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected the counters to be proxied, got %d", w.Code)
	}
	if w.Body.String() != `{"wireBytes":123}` {
		t.Errorf("the proxy did not deliver the streamer's counters: %q", w.Body.String())
	}
}

// The spike forensics reads the streamer's wire log once per run, from outside
// the container like everything else. Without this route the request falls
// through to the page's own static handler and is answered with index.html -
// which parses as JSON never, and which a bench would report as a broken run
// rather than as a missing route.
func TestStreamProxy_ServesTheStreamersWireLog(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/df-wire" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"now":1,"events":[[1,2,131088,0,0,0]],"stamps":[]}`))
	}))
	defer backend.Close()

	u, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatalf("failed to parse backend url: %v", err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("failed to parse backend port: %v", err)
	}

	mux := http.NewServeMux()
	RegisterStreamProxy(mux, port)

	req := httptest.NewRequest("GET", "/df-wire", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected the wire log to be proxied, got %d", w.Code)
	}
	if w.Body.String() != `{"now":1,"events":[[1,2,131088,0,0,0]],"stamps":[]}` {
		t.Errorf("the proxy did not deliver the streamer's wire log: %q", w.Body.String())
	}
}
