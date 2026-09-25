package session

import (
	"runtime"
	"testing"
	"time"

	"github.com/cyclone1070/remote-df/server/domain"
)

func TestProcessSupervisor_Lifecycle(t *testing.T) {
	sup := NewProcessSupervisor()

	status := sup.Status()
	if status.State != StateIdle {
		t.Fatalf("expected initial state idle, got %s", status.State)
	}

	execName := "sleep"
	if runtime.GOOS == "windows" {
		execName = "timeout"
	}

	manifest := domain.GameManifest{
		ID:           "test-sleep",
		Name:         "Sleep Process",
		Executable:   execName,
		RequiresXvfb: false,
	}

	err := sup.Start(manifest, []string{"2"}, 8485)
	if err != nil {
		t.Fatalf("failed to start supervisor: %v", err)
	}

	status = sup.Status()
	if status.State != StateRunning {
		t.Errorf("expected state running, got %s", status.State)
	}
	if status.GameID != "test-sleep" {
		t.Errorf("expected gameID test-sleep, got %s", status.GameID)
	}

	// Conflict test
	err = sup.Start(manifest, []string{"2"}, 8485)
	if err == nil {
		t.Errorf("expected conflict starting already active session")
	}

	// Stop test
	startStop := time.Now()
	err = sup.Stop()
	if err != nil {
		t.Fatalf("Stop() returned error: %v", err)
	}

	if time.Since(startStop) > 1500*time.Millisecond {
		t.Errorf("Stop() took too long: %v", time.Since(startStop))
	}

	status = sup.Status()
	if status.State != StateIdle {
		t.Errorf("expected idle state after Stop(), got %s", status.State)
	}
}
