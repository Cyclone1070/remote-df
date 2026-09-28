//go:build embed_ui

package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed dist/*
var embeddedDist embed.FS

// RegisterUIRoutes mounts embedded Single Page Application routes onto the mux unless headless is true.
func RegisterUIRoutes(mux *http.ServeMux, headless bool) {
	if headless {
		return
	}

	distFS, err := fs.Sub(embeddedDist, "dist")
	if err != nil {
		return
	}

	fileServer := http.FileServer(http.FS(distFS))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Never intercept API routes
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}

		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}

		// If static asset exists in embedded FS, serve it
		if f, err := distFS.Open(path); err == nil {
			_ = f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}

		// Single Page Application fallback: route to root index.html
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}
