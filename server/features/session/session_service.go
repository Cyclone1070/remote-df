package session

import (
	"errors"
	"fmt"

	"github.com/cyclone1070/remote-df/server/domain"
	"github.com/cyclone1070/remote-df/server/features/session/dto"
)

var (
	ErrGameNotFound    = errors.New("game not found")
	ErrSessionConflict = errors.New("session already running")
)

// SessionService coordinates session lifecycle operations between supervisor and game registry.
type SessionService struct {
	supervisor SessionSupervisor
	registry   domain.GameRegistry
	streamPort int
}

// NewSessionService constructs a new SessionService with injected dependencies.
func NewSessionService(supervisor SessionSupervisor, registry domain.GameRegistry, streamPort int) *SessionService {
	return &SessionService{
		supervisor: supervisor,
		registry:   registry,
		streamPort: streamPort,
	}
}

// GetStatus returns the current active session state.
func (s *SessionService) GetStatus() SessionStatus {
	return s.supervisor.Status()
}

// StartSession initiates a new game session using the manifest provided by the registry.
func (s *SessionService) StartSession(req dto.StartSessionRequest) (*SessionStatus, error) {
	manifest, ok := s.registry.Get(req.GameID)
	if !ok {
		return nil, fmt.Errorf("%w: game '%s' not found", ErrGameNotFound, req.GameID)
	}

	if err := s.supervisor.Start(manifest, req.Args, s.streamPort); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrSessionConflict, err)
	}

	status := s.supervisor.Status()
	return &status, nil
}

// StopSession halts the running game process and tears down streamer resources.
func (s *SessionService) StopSession() (*SessionStatus, error) {
	if err := s.supervisor.Stop(); err != nil {
		return nil, err
	}
	status := s.supervisor.Status()
	return &status, nil
}
