// Package domain defines pure cross-slice contracts and shared data models.
// Types here must be consumed across 2+ feature slices with zero framework or infrastructure dependencies.
package domain

// Tag represents a categorized label (genre, subgenre, etc.) for a game.
type Tag struct {
	Name  string `json:"name" example:"Simulation"`
	Level string `json:"level" example:"genre" enums:"genre,subgenre"`
}

// GameManifest represents a configured game's launch and display properties.
type GameManifest struct {
	ID           string            `json:"id" example:"dwarf-fortress"`
	Name         string            `json:"name" example:"Dwarf Fortress"`
	Description  string            `json:"description,omitempty" example:"The deepest, most intricate simulation of a world that's ever been created."`
	Executable   string            `json:"executable" example:"/game/dwarfort"`
	WorkingDir   string            `json:"workingDir" example:"/game"`
	RequiresXvfb bool              `json:"requiresXvfb" example:"true"`
	Engine       string            `json:"engine" example:"sdl2-opengl"`
	Tags         []Tag             `json:"tags,omitempty"`
	SaveDirs     []string          `json:"saveDirs,omitempty" example:"data/save"`
	Env          map[string]string `json:"env,omitempty"`
}

// GameRegistry defines the interface for discovering and retrieving game manifests.
type GameRegistry interface {
	List() ([]GameManifest, error)
	Get(id string) (GameManifest, bool)
}
