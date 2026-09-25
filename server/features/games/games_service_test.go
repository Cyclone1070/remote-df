package games

import (
	"testing"

	"github.com/cyclone1070/remote-df/server/domain"
)

type mockGameRegistry struct {
	games []domain.GameManifest
	err   error
}

func (m *mockGameRegistry) List() ([]domain.GameManifest, error) {
	if m.err != nil {
		return nil, m.err
	}
	return m.games, nil
}

func (m *mockGameRegistry) Get(id string) (domain.GameManifest, bool) {
	if m.err != nil {
		return domain.GameManifest{}, false
	}
	for _, g := range m.games {
		if g.ID == id {
			return g, true
		}
	}
	return domain.GameManifest{}, false
}

func TestGamesService_ListGames(t *testing.T) {
	reg := &mockGameRegistry{
		games: []domain.GameManifest{
			{ID: "df", Name: "Dwarf Fortress"},
		},
	}
	svc := NewGamesService(reg)
	res, err := svc.ListGames()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res) != 1 || res[0].ID != "df" {
		t.Fatalf("expected df, got %v", res)
	}
}

func TestGamesService_GetGame(t *testing.T) {
	reg := &mockGameRegistry{
		games: []domain.GameManifest{
			{ID: "df", Name: "Dwarf Fortress"},
		},
	}
	svc := NewGamesService(reg)
	game, ok := svc.GetGame("df")
	if !ok {
		t.Fatalf("expected game found")
	}
	if game.Name != "Dwarf Fortress" {
		t.Fatalf("expected Dwarf Fortress, got %s", game.Name)
	}

	_, ok = svc.GetGame("nonexistent")
	if ok {
		t.Fatalf("expected false for nonexistent game")
	}
}
