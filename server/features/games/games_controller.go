package games

import (
	"encoding/json"
	"net/http"

	"github.com/cyclone1070/remote-df/server/domain"
)

// GamesController handles HTTP endpoints for discovering and querying games.
type GamesController struct {
	service *GamesService
}

// NewGamesController creates a new GamesController with injected GamesService dependency.
func NewGamesController(service *GamesService) *GamesController {
	return &GamesController{service: service}
}

// RegisterRoutes mounts game endpoints onto the provided mux.
func (c *GamesController) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/games", c.ListGames)
}

// ListGames godoc
// @Summary      List discovered games
// @Description  Scans the games directory and returns manifests with metadata and tags.
// @Tags         games
// @Produce      json
// @Success      200  {array}   domain.GameManifest
// @Failure      500  {object}  domain.ErrorResponse
// @Router       /api/games [get]
func (c *GamesController) ListGames(w http.ResponseWriter, r *http.Request) {
	games, err := c.service.ListGames()
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(domain.ErrorResponse{Error: err.Error()})
		return
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(games)
}
