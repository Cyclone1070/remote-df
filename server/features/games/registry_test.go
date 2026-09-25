package games

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFileSystemRegistry_ListAndGet(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "games-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	gameDir := filepath.Join(tempDir, "test-game")
	if err := os.MkdirAll(gameDir, 0755); err != nil {
		t.Fatalf("failed to create game dir: %v", err)
	}

	manifestJSON := `{
		"id": "test-game",
		"name": "Test Game",
		"executable": "/game/test",
		"tags": [{"name": "Indie", "level": "genre"}]
	}`
	if err := os.WriteFile(filepath.Join(gameDir, "manifest.json"), []byte(manifestJSON), 0644); err != nil {
		t.Fatalf("failed to write manifest: %v", err)
	}

	reg := NewFileSystemRegistry(tempDir)
	list, err := reg.List()
	if err != nil {
		t.Fatalf("List() returned error: %v", err)
	}

	if len(list) != 1 {
		t.Fatalf("expected 1 game, got %d", len(list))
	}

	if list[0].Name != "Test Game" || len(list[0].Tags) != 1 || list[0].Tags[0].Name != "Indie" {
		t.Errorf("unexpected game in list: %+v", list[0])
	}

	m, ok := reg.Get("test-game")
	if !ok || m.Name != "Test Game" {
		t.Errorf("Get() failed or returned unexpected manifest: %+v", m)
	}

	_, ok = reg.Get("nonexistent")
	if ok {
		t.Errorf("expected Get(nonexistent) to return false")
	}
}
