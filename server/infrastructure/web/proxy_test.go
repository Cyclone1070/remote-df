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
