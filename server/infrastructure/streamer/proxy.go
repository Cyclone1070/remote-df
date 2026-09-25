package streamer

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// StreamerProxy acts as a reverse proxy forwarding WebSockets and HTTP stream requests to the interposer.
type StreamerProxy struct {
	proxy *httputil.ReverseProxy
}

// NewStreamerProxy creates a new proxy targeting the specified stream port.
func NewStreamerProxy(streamPort int) *StreamerProxy {
	targetURL, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", streamPort))
	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	return &StreamerProxy{proxy: proxy}
}

// RegisterRoutes registers streaming routes.
func (p *StreamerProxy) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ws", p.ServeHTTP)
	mux.HandleFunc("/stream", p.ServeHTTP)
}

func (p *StreamerProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.proxy.ServeHTTP(w, r)
}
