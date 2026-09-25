package session

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/cyclone1070/remote-df/server/domain"
	"github.com/cyclone1070/remote-df/server/features/session/dto"
)

// SessionController handles session management HTTP endpoints.
type SessionController struct {
	service *SessionService
}

// NewSessionController creates a new SessionController with injected SessionService dependency.
func NewSessionController(service *SessionService) *SessionController {
	return &SessionController{service: service}
}

// RegisterRoutes mounts session endpoints onto the provided mux.
func (c *SessionController) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/session", c.GetStatus)
	mux.HandleFunc("POST /api/session/start", c.StartSession)
	mux.HandleFunc("POST /api/session/stop", c.StopSession)
}

// GetStatus godoc
// @Summary      Get current game session status
// @Description  Returns live status snapshot of the current streaming session.
// @Tags         session
// @Produce      json
// @Success      200  {object}  SessionStatus
// @Router       /api/session [get]
func (c *SessionController) GetStatus(w http.ResponseWriter, r *http.Request) {
	status := c.service.GetStatus()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(status)
}

// StartSession godoc
// @Summary      Launch a game session
// @Description  Starts a new game instance and its virtual display framebuffer.
// @Tags         session
// @Accept       json
// @Produce      json
// @Param        request  body      dto.StartSessionRequest  true  "Game launch configuration"
// @Success      200      {object}  SessionStatus
// @Failure      400      {object}  domain.ErrorResponse
// @Failure      404      {object}  domain.ErrorResponse
// @Failure      409      {object}  domain.ErrorResponse
// @Router       /api/session/start [post]
func (c *SessionController) StartSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	var req dto.StartSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(domain.ErrorResponse{Error: "invalid json body"})
		return
	}

	status, err := c.service.StartSession(req)
	if err != nil {
		if errors.Is(err, ErrGameNotFound) {
			w.WriteHeader(http.StatusNotFound)
		} else if errors.Is(err, ErrSessionConflict) {
			w.WriteHeader(http.StatusConflict)
		} else {
			w.WriteHeader(http.StatusInternalServerError)
		}
		_ = json.NewEncoder(w).Encode(domain.ErrorResponse{Error: err.Error()})
		return
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(status)
}

// StopSession godoc
// @Summary      Terminate the active game session
// @Description  Safely stops the active game session and tears down virtual framebuffers.
// @Tags         session
// @Produce      json
// @Success      200  {object}  SessionStatus
// @Failure      500  {object}  domain.ErrorResponse
// @Router       /api/session/stop [post]
func (c *SessionController) StopSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	status, err := c.service.StopSession()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(domain.ErrorResponse{Error: err.Error()})
		return
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(status)
}
