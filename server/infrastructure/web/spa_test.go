package web

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestSPARouter(t *testing.T) {
	tmpDir := t.TempDir()
	indexFile := filepath.Join(tmpDir, "index.html")
	_ = os.WriteFile(indexFile, []byte("<html>SPA</html>"), 0644)

	spa := NewSPARouter(tmpDir)

	// Route that does not exist -> fall back to index.html
	req := httptest.NewRequest("GET", "/dashboard", nil)
	w := httptest.NewRecorder()
	spa.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if w.Body.String() != "<html>SPA</html>" {
		t.Fatalf("expected index.html body, got %s", w.Body.String())
	}

	// API route -> 404
	apiReq := httptest.NewRequest("GET", "/api/unknown", nil)
	apiW := httptest.NewRecorder()
	spa.ServeHTTP(apiW, apiReq)
	if apiW.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for API path, got %d", apiW.Code)
	}
}
