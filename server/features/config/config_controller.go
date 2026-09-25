package config

import (
	"encoding/json"
	"net/http"

	"github.com/cyclone1070/remote-df/server/features/config/dto"
)

// ServerConfig represents the server deployment settings and capabilities.
type ServerConfig struct {
	Mode         string `json:"mode" example:"self-hosted"`
	AuthRequired bool   `json:"authRequired" example:"false"`
}

// ConfigController handles server configuration HTTP endpoints.
type ConfigController struct {
	service *ConfigService
}

// NewConfigController creates a new ConfigController with injected ConfigService.
func NewConfigController(service *ConfigService) *ConfigController {
	return &ConfigController{service: service}
}

// RegisterRoutes mounts config routes onto the provided mux.
func (c *ConfigController) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/config", c.GetConfig)
}

// GetConfig godoc
// @Summary      Get server configuration
// @Description  Returns deployment mode and authentication requirements.
// @Tags         config
// @Produce      json
// @Success      200  {object}  dto.ConfigResponseDto
// @Router       /api/config [get]
func (c *ConfigController) GetConfig(w http.ResponseWriter, r *http.Request) {
	var cfg dto.ConfigResponseDto = c.service.GetServerConfig()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(cfg)
}
