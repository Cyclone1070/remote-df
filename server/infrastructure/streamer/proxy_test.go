package streamer

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStreamerProxy_ServeHTTP(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "stream-ok")
	}))
	defer backend.Close()

	proxy := NewStreamerProxy(8485)
	if proxy == nil {
		t.Fatalf("expected proxy instance")
	}

	mux := http.NewServeMux()
	proxy.RegisterRoutes(mux)
}
