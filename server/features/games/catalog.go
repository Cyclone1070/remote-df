package games

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/cyclone1070/remote-df/server/domain"
)

// GameDefinition defines compile-time configuration for a supported game in Remote-DF.
type GameDefinition struct {
	ID           string
	Name         string
	Description  string
	Engine       string
	RequiresXvfb bool
	Tags         []domain.Tag
	SaveDirs     []string
	BinaryName   string
	DefaultDir   string
	EnvKey       string
	PreloadLib   string
}

// CatalogRegistry provides a fixed, compile-time catalog of supported games with runtime availability checks.
type CatalogRegistry struct {
	mu          sync.RWMutex
	definitions []GameDefinition
}

// DefaultGameCatalog lists all officially supported games in Remote-DF.
var DefaultGameCatalog = []GameDefinition{
	{
		ID:           "dwarf-fortress",
		Name:         "Dwarf Fortress",
		Description:  "The deepest, most intricate simulation of a world that's ever been created.",
		Engine:       "sdl2-opengl",
		RequiresXvfb: true,
		Tags: []domain.Tag{
			{Name: "Simulation", Level: "genre"},
			{Name: "Colony Sim", Level: "subgenre"},
		},
		SaveDirs:   []string{"data/save"},
		BinaryName: "dwarfort",
		DefaultDir: "/game",
		EnvKey:     "DF_DIR",
		PreloadLib: "/app/libdf_streamer.so",
	},
}

// NewCatalogRegistry creates a new catalog registry initialized with the default games catalog.
func NewCatalogRegistry() *CatalogRegistry {
	return &CatalogRegistry{
		definitions: DefaultGameCatalog,
	}
}

// List evaluates each catalog game against the current runtime environment.
func (r *CatalogRegistry) List() ([]domain.GameManifest, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	results := make([]domain.GameManifest, 0, len(r.definitions))
	for _, def := range r.definitions {
		results = append(results, r.buildManifest(def))
	}
	return results, nil
}

// Get finds a specific game by ID and calculates its live availability.
func (r *CatalogRegistry) Get(id string) (domain.GameManifest, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, def := range r.definitions {
		if def.ID == id {
			return r.buildManifest(def), true
		}
	}
	return domain.GameManifest{}, false
}

func (r *CatalogRegistry) buildManifest(def GameDefinition) domain.GameManifest {
	installDir := def.DefaultDir
	if def.EnvKey != "" {
		if val := os.Getenv(def.EnvKey); val != "" {
			installDir = val
		}
	}

	execPath := filepath.Join(installDir, def.BinaryName)
	available := false
	if info, err := os.Stat(execPath); err == nil && !info.IsDir() {
		available = true
	}

	return domain.GameManifest{
		ID:           def.ID,
		Name:         def.Name,
		Description:  def.Description,
		Executable:   execPath,
		WorkingDir:   installDir,
		RequiresXvfb: def.RequiresXvfb,
		Engine:       def.Engine,
		Tags:         def.Tags,
		SaveDirs:     def.SaveDirs,
		Available:    available,
		InstallDir:   installDir,
		Env: map[string]string{
			"LD_PRELOAD":      def.PreloadLib,
			"LD_LIBRARY_PATH": fmt.Sprintf("%s:.", installDir),
		},
	}
}
