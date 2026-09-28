package web

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRegisterUIRoutes_Headless(t *testing.T) {
	mux := http.NewServeMux()
	RegisterUIRoutes(mux, true)

	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 in headless mode, got %d", w.Code)
	}
}
