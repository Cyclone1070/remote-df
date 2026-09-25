package session

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/cyclone1070/remote-df/server/domain"
)

// ProcessSupervisor manages the execution lifecycle of game processes and virtual framebuffers.
type ProcessSupervisor struct {
	mu        sync.Mutex
	state     SessionState
	gameID    string
	gameName  string
	startedAt time.Time
	gameCmd   *exec.Cmd
	xvfbCmd   *exec.Cmd
}

// NewProcessSupervisor creates a new idle process supervisor.
func NewProcessSupervisor() *ProcessSupervisor {
	return &ProcessSupervisor{
		state: StateIdle,
	}
}

// Status returns the current live status snapshot of the supervisor.
func (s *ProcessSupervisor) Status() SessionStatus {
	s.mu.Lock()
	defer s.mu.Unlock()

	var uptime int64
	if !s.startedAt.IsZero() && s.state == StateRunning {
		uptime = int64(time.Since(s.startedAt).Seconds())
	}

	pid := 0
	if s.gameCmd != nil && s.gameCmd.Process != nil {
		pid = s.gameCmd.Process.Pid
	}

	return SessionStatus{
		State:     s.state,
		GameID:    s.gameID,
		GameName:  s.gameName,
		PID:       pid,
		UptimeSec: uptime,
		StartedAt: s.startedAt,
	}
}

// Start launches Xvfb (if required) and the game process.
func (s *ProcessSupervisor) Start(m domain.GameManifest, args []string, streamPort int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.state != StateIdle {
		return fmt.Errorf("session already active in state: %s", s.state)
	}

	s.state = StateStarting
	s.gameID = m.ID
	s.gameName = m.Name

	// 1. Start Xvfb if required on Linux
	if m.RequiresXvfb && runtime.GOOS == "linux" {
		_ = os.Remove("/tmp/.X99-lock")
		_ = os.Remove("/tmp/.X11-unix/X99")

		xvfb := exec.Command("Xvfb", ":99", "-screen", "0", "2560x1440x24", "-ac", "+extension", "GLX", "+render", "-noreset")
		xvfb.Stdout = os.Stdout
		xvfb.Stderr = os.Stderr
		if err := xvfb.Start(); err != nil {
			s.state = StateIdle
			return fmt.Errorf("failed to start Xvfb: %w", err)
		}
		s.xvfbCmd = xvfb

		// Wait for Xvfb socket
		for i := 0; i < 20; i++ {
			if _, err := os.Stat("/tmp/.X11-unix/X99"); err == nil {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
	}

	// 2. Prepare Game Command
	cmd := exec.Command(m.Executable, args...)
	if m.WorkingDir != "" {
		cmd.Dir = m.WorkingDir
	}

	env := os.Environ()
	if m.RequiresXvfb && runtime.GOOS == "linux" {
		env = append(env, "DISPLAY=:99")
	}
	env = append(env, fmt.Sprintf("PORT=%d", streamPort))
	for k, v := range m.Env {
		env = append(env, fmt.Sprintf("%s=%s", k, v))
	}
	cmd.Env = env
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		s.cleanupProcesses()
		s.state = StateIdle
		return fmt.Errorf("failed to start game executable: %w", err)
	}

	s.gameCmd = cmd
	s.startedAt = time.Now()
	s.state = StateRunning

	// 3. Monitor process exit asynchronously
	go func() {
		_ = cmd.Wait()

		s.mu.Lock()
		defer s.mu.Unlock()

		if s.xvfbCmd != nil && s.xvfbCmd.Process != nil {
			_ = s.xvfbCmd.Process.Kill()
			_ = s.xvfbCmd.Wait()
			s.xvfbCmd = nil
		}

		s.state = StateIdle
		s.gameID = ""
		s.gameName = ""
		s.gameCmd = nil
		s.startedAt = time.Time{}
	}()

	return nil
}

// Stop safely terminates the active game session and reaps child processes.
func (s *ProcessSupervisor) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.state == StateIdle {
		return nil
	}

	s.state = StateStopping
	s.cleanupProcesses()
	s.state = StateIdle
	s.gameID = ""
	s.gameName = ""
	s.startedAt = time.Time{}
	return nil
}

func (s *ProcessSupervisor) cleanupProcesses() {
	if s.gameCmd != nil && s.gameCmd.Process != nil {
		_ = s.gameCmd.Process.Signal(syscall.SIGTERM)

		done := make(chan error, 1)
		go func() { done <- s.gameCmd.Wait() }()

		select {
		case <-done:
		case <-time.After(500 * time.Millisecond):
			_ = s.gameCmd.Process.Kill()
		}
		s.gameCmd = nil
	}

	if s.xvfbCmd != nil && s.xvfbCmd.Process != nil {
		_ = s.xvfbCmd.Process.Signal(syscall.SIGTERM)
		_ = s.xvfbCmd.Process.Kill()
		_ = s.xvfbCmd.Wait()
		s.xvfbCmd = nil
	}
}
