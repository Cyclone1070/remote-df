package web

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// RegisterStreamProxy mounts reverse-proxy for the game stream WebSocket on /ws,
// for the streamer's own counters on /df-stats, and for its wire log on
// /df-wire. The wire log is what the spike forensics reads to see which message
// a slow frame queued behind; without a route here the request is answered by
// the page's static handler, which looks like a broken bench rather than a
// missing route.
//
// The counters are counted inside the process that does the sending, and this
// server is the only way to reach that process from outside the container.
// Proxying them keeps one number with one definition; the alternative - scraping
// the streamer's log - would be a different number that merely looks like the
// same one.
func RegisterStreamProxy(mux *http.ServeMux, streamPort int) {
	targetURL, err := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", streamPort))
	if err != nil {
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	mux.Handle("/ws", proxy)
	mux.Handle("/df-stats", proxy)
	mux.Handle("/df-wire", proxy)
}
