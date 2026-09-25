package games

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/cyclone1070/remote-df/server/domain"
)

// FileSystemRegistry discovers and caches game manifests from the filesystem.
type FileSystemRegistry struct {
	baseDir string
	mu      sync.RWMutex
	cache   map[string]domain.GameManifest
}

// NewFileSystemRegistry creates a new registry scanning baseDir for game folders.
func NewFileSystemRegistry(baseDir string) *FileSystemRegistry {
	return &FileSystemRegistry{
		baseDir: baseDir,
		cache:   make(map[string]domain.GameManifest),
	}
}

// List scans baseDir for subdirectories with manifest.json files.
func (r *FileSystemRegistry) List() ([]domain.GameManifest, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	entries, err := os.ReadDir(r.baseDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []domain.GameManifest{}, nil
		}
		return nil, fmt.Errorf("failed to read games directory: %w", err)
	}

	var results []domain.GameManifest
	r.cache = make(map[string]domain.GameManifest)

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		manifestPath := filepath.Join(r.baseDir, entry.Name(), "manifest.json")
		data, err := os.ReadFile(manifestPath)
		if err != nil {
			continue
		}

		var m domain.GameManifest
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		if m.ID == "" {
			m.ID = entry.Name()
		}
		r.cache[m.ID] = m
		results = append(results, m)
	}

	return results, nil
}

// Get returns the cached or newly discovered manifest for a game ID.
func (r *FileSystemRegistry) Get(id string) (domain.GameManifest, bool) {
	r.mu.RLock()
	m, ok := r.cache[id]
	r.mu.RUnlock()
	if ok {
		return m, true
	}

	// Try scanning once on cache miss
	_, _ = r.List()

	r.mu.RLock()
	defer r.mu.RUnlock()
	m, ok = r.cache[id]
	return m, ok
}
