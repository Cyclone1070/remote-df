package web

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// RegisterStreamProxy mounts reverse-proxy for the game stream WebSocket on /ws.
func RegisterStreamProxy(mux *http.ServeMux, streamPort int) {
	targetURL, err := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", streamPort))
	if err != nil {
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	mux.Handle("/ws", proxy)
}
