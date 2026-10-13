package raw

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func fetchPage(t *testing.T, path string) (int, string, string) {
	t.Helper()

	server := newRawTestServer(t, NewFrameHolder(), &fakeSink{})

	response, err := http.Get(server.URL + path)
	if err != nil {
		t.Fatalf("request for %s failed: %v", path, err)
	}
	defer func() {
		_ = response.Body.Close()
	}()

	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("failed to read %s: %v", path, err)
	}

	return response.StatusCode, response.Header.Get("Content-Type"), string(body)
}

func TestRawController_PageIsSelfContained(t *testing.T) {
	status, contentType, page := fetchPage(t, "/")

	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	if !strings.HasPrefix(contentType, "text/html") {
		t.Fatalf("expected an html response, got %q", contentType)
	}

	mustContain := []string{
		`<img id="screen" src="/raw.mjpg"`, // the browser's own MJPEG rendering
		`id="hud"`,                         // the QA overlay
		`/raw-input`,                       // where input is sent
		`new WebSocket(`,
		// The input layout copied from the React client's encodeInput.
		`setUint8(0,`,
		`setInt16(1,`,
		`setInt16(3,`,
		`setUint8(5,`,
		`setUint32(6,`,
		`setUint32(10,`,
		`setUint16(14,`,
		`1073741912`, // the NumpadEnter symbol, proving translateKey was reused
		`overflow: hidden`,
		`background: #000`,
	}
	for _, needle := range mustContain {
		if !strings.Contains(page, needle) {
			t.Errorf("page does not contain %q", needle)
		}
	}

	mustNotContain := []string{
		`<script src=`, // self-contained: no external scripts
		`<link `,       // and no external stylesheets
		`@import`,
		`http://`,
		`https://`,
	}
	for _, needle := range mustNotContain {
		if strings.Contains(page, needle) {
			t.Errorf("page must be self-contained but contains %q", needle)
		}
	}
}

func TestRawController_PageOnlyAnswersTheRoot(t *testing.T) {
	status, _, _ := fetchPage(t, "/whatever")

	if status != http.StatusNotFound {
		t.Fatalf("expected 404 for an unknown path, got %d", status)
	}
}
