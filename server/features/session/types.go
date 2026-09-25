package session

import (
	"time"

	"github.com/cyclone1070/remote-df/server/domain"
)

// SessionState represents the lifecycle state of a streaming session.
type SessionState string

const (
	StateIdle     SessionState = "idle"
	StateStarting SessionState = "starting"
	StateRunning  SessionState = "running"
	StateStopping SessionState = "stopping"
)

// SessionStatus represents the live runtime state of a game session.
type SessionStatus struct {
	State     SessionState `json:"state" example:"running" enums:"idle,starting,running,stopping"`
	GameID    string       `json:"gameId,omitempty" example:"dwarf-fortress"`
	GameName  string       `json:"gameName,omitempty" example:"Dwarf Fortress"`
	PID       int          `json:"pid,omitempty" example:"104"`
	UptimeSec int64        `json:"uptimeSec,omitempty" example:"42"`
	StartedAt time.Time    `json:"startedAt" example:"2026-09-25T02:00:00Z"`
}

// SessionSupervisor defines the interface for controlling the game process lifecycle.
type SessionSupervisor interface {
	Status() SessionStatus
	Start(manifest domain.GameManifest, args []string, streamPort int) error
	Stop() error
}
