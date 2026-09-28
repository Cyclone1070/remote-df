package games

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCatalogRegistry_ListAndAvailability(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "catalog-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Set DF_DIR to tempDir
	t.Setenv("DF_DIR", tempDir)

	reg := NewCatalogRegistry()

	// 1. Initial state: dwarfort binary does not exist -> available: false
	games, err := reg.List()
	if err != nil {
		t.Fatalf("unexpected error listing games: %v", err)
	}
	if len(games) == 0 {
		t.Fatalf("expected at least 1 game in catalog")
	}

	df, ok := reg.Get("dwarf-fortress")
	if !ok {
		t.Fatalf("dwarf-fortress not found in catalog")
	}
	if df.Available {
		t.Errorf("expected dwarf-fortress to be unavailable before binary exists")
	}
	if df.WorkingDir != tempDir {
		t.Errorf("expected working dir %s, got %s", tempDir, df.WorkingDir)
	}

	// 2. Create fake dwarfort executable -> available: true
	fakeBin := filepath.Join(tempDir, "dwarfort")
	if err := os.WriteFile(fakeBin, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatalf("failed to write fake binary: %v", err)
	}

	dfUpdated, ok := reg.Get("dwarf-fortress")
	if !ok {
		t.Fatalf("dwarf-fortress not found after creating binary")
	}
	if !dfUpdated.Available {
		t.Errorf("expected dwarf-fortress to be available after binary exists")
	}

	// 3. Check tags and metadata
	if len(dfUpdated.Tags) != 2 {
		t.Errorf("expected 2 tags, got %d", len(dfUpdated.Tags))
	}
	if dfUpdated.Tags[0].Name != "Simulation" || dfUpdated.Tags[1].Name != "Colony Sim" {
		t.Errorf("unexpected tags: %+v", dfUpdated.Tags)
	}
}
