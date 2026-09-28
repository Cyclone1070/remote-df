//go:build !embed_ui

package web

import "net/http"

// RegisterUIRoutes mounts UI routes onto the mux.
// In headless builds, this is a no-op (pure API mode).
func RegisterUIRoutes(mux *http.ServeMux, headless bool) {
	// Pure headless API: zero embedded frontend assets, no UI routes mounted
}
