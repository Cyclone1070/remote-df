package games

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cyclone1070/remote-df/server/domain"
)

func TestGamesController_ListGames_Success(t *testing.T) {
	mockReg := &mockGameRegistry{
		games: []domain.GameManifest{
			{
				ID:          "df",
				Name:        "Dwarf Fortress",
				Description: "Sim",
				Tags: []domain.Tag{
					{Name: "Simulation", Level: "genre"},
				},
			},
		},
	}
	svc := NewGamesService(mockReg)
	ctrl := NewGamesController(svc)

	req := httptest.NewRequest("GET", "/api/games", nil)
	w := httptest.NewRecorder()

	ctrl.ListGames(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var results []domain.GameManifest
	if err := json.Unmarshal(w.Body.Bytes(), &results); err != nil {
		t.Fatalf("failed to parse response JSON: %v", err)
	}

	if len(results) != 1 || results[0].ID != "df" {
		t.Fatalf("unexpected games returned: %+v", results)
	}
}

func TestGamesController_ListGames_Error(t *testing.T) {
	mockReg := &mockGameRegistry{
		err: fmt.Errorf("disk failure"),
	}
	svc := NewGamesService(mockReg)
	ctrl := NewGamesController(svc)

	req := httptest.NewRequest("GET", "/api/games", nil)
	w := httptest.NewRecorder()

	ctrl.ListGames(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}
