package raw

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// Both paths must agree about what a freeze is. The page is served the same
// module the React client imports, and this is what keeps the copy in this
// package from drifting away from the original.
func TestMeasureModule_MatchesTheClientCopy(t *testing.T) {
	clientSource, err := os.ReadFile("../../../client/src/core/measure.js")
	if err != nil {
		t.Fatalf("failed to read the client's measure.js: %v", err)
	}

	if measureModule != string(clientSource) {
		t.Fatal("server/features/raw/measure.js has drifted from client/src/core/measure.js; " +
			"copy the client file over it so both paths measure the same event")
	}
}

// The serving page must not open a second read of the stream. A second
// subscription is not the picture the player is looking at: it is a separate
// connection, its delivery is not the element's delivery, and a chunk that
// carries several parts stamps them all with one timestamp - which is how a
// 60 Hz display was once reported as showing 117 frames a second.
func TestRawPage_HasOneSubscriptionAndTheMeasurementModule(t *testing.T) {
	controller := NewRawController(NewFrameHolder(), &fakeSink{})
	mux := http.NewServeMux()
	controller.RegisterRoutes(mux)
	server := httptest.NewServer(mux)
	defer server.Close()

	resp, err := http.Get(server.URL + "/")
	if err != nil {
		t.Fatalf("failed to fetch the page: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body := make([]byte, 1<<20)
	n, _ := resp.Body.Read(body)
	page := string(body[:n])

	if strings.Contains(page, "fetch('/raw.mjpg')") {
		t.Error("the page reads the stream a second time; the displayed element is the only honest source")
	}
	if strings.Count(page, "src=\"/raw.mjpg\"") != 1 {
		t.Error("expected exactly one element subscribed to the picture stream")
	}
	if !strings.Contains(page, "function freezeReport(") {
		t.Error("the measurement module was not spliced into the page")
	}
	if strings.Contains(page, measureMarker) {
		t.Error("the marker survived; the module was never substituted")
	}
}
