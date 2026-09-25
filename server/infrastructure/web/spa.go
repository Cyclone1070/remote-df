package web

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// SPARouter serves static frontend assets with Single Page Application fallback to index.html.
type SPARouter struct {
	staticDir string
}

// NewSPARouter creates a new SPARouter targeting the client directory.
func NewSPARouter(staticDir string) *SPARouter {
	return &SPARouter{staticDir: staticDir}
}

// RegisterRoutes registers the fallback SPA handler on the mux.
func (s *SPARouter) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/", s.ServeHTTP)
}

func (s *SPARouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Do not intercept API or websocket routes
	if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/ws" || r.URL.Path == "/stream" {
		http.NotFound(w, r)
		return
	}

	targetPath := filepath.Join(s.staticDir, filepath.Clean(r.URL.Path))
	info, err := os.Stat(targetPath)
	if err == nil && !info.IsDir() {
		http.ServeFile(w, r, targetPath)
		return
	}

	indexPath := filepath.Join(s.staticDir, "index.html")
	if _, err := os.Stat(indexPath); err == nil {
		http.ServeFile(w, r, indexPath)
		return
	}

	http.NotFound(w, r)
}
