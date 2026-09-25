package games

import (
	"github.com/cyclone1070/remote-df/server/domain"
)

// GamesService encapsulates domain business logic for game discovery and catalog retrieval.
type GamesService struct {
	registry domain.GameRegistry
}

// NewGamesService constructs a new GamesService with injected GameRegistry.
func NewGamesService(registry domain.GameRegistry) *GamesService {
	return &GamesService{registry: registry}
}

// ListGames retrieves all available game manifests.
func (s *GamesService) ListGames() ([]domain.GameManifest, error) {
	return s.registry.List()
}

// GetGame retrieves a specific game manifest by identifier.
func (s *GamesService) GetGame(id string) (domain.GameManifest, bool) {
	return s.registry.Get(id)
}
