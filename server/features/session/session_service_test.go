package session

import (
	"errors"
	"testing"

	"github.com/cyclone1070/remote-df/server/domain"
	"github.com/cyclone1070/remote-df/server/features/session/dto"
)

type mockSupervisor struct {
	status   SessionStatus
	startErr error
	stopErr  error
}

func (m *mockSupervisor) Status() SessionStatus {
	return m.status
}

func (m *mockSupervisor) Start(manifest domain.GameManifest, args []string, streamPort int) error {
	if m.startErr != nil {
		return m.startErr
	}
	if m.status.State == StateRunning {
		return errors.New("already running")
	}
	m.status = SessionStatus{
		State:  StateRunning,
		GameID: manifest.ID,
	}
	return nil
}

func (m *mockSupervisor) Stop() error {
	if m.stopErr != nil {
		return m.stopErr
	}
	m.status = SessionStatus{State: StateIdle}
	return nil
}

type mockGameRegistry struct {
	manifests map[string]domain.GameManifest
}

func (m *mockGameRegistry) List() ([]domain.GameManifest, error) {
	var list []domain.GameManifest
	for _, v := range m.manifests {
		list = append(list, v)
	}
	return list, nil
}

func (m *mockGameRegistry) Get(id string) (domain.GameManifest, bool) {
	if v, ok := m.manifests[id]; ok {
		return v, true
	}
	return domain.GameManifest{}, false
}

func TestSessionService_Lifecycle(t *testing.T) {
	mockSup := &mockSupervisor{
		status: SessionStatus{State: StateIdle},
	}
	mockReg := &mockGameRegistry{
		manifests: map[string]domain.GameManifest{
			"df": {ID: "df", Name: "Dwarf Fortress"},
		},
	}

	svc := NewSessionService(mockSup, mockReg, 8485)

	// Status check
	status := svc.GetStatus()
	if status.State != StateIdle {
		t.Fatalf("expected idle, got %s", status.State)
	}

	// Start success
	startRes, err := svc.StartSession(dto.StartSessionRequest{GameID: "df"})
	if err != nil {
		t.Fatalf("unexpected error starting session: %v", err)
	}
	if startRes.State != StateRunning {
		t.Fatalf("expected running state, got %s", startRes.State)
	}

	// Start not found
	_, err = svc.StartSession(dto.StartSessionRequest{GameID: "nonexistent"})
	if !errors.Is(err, ErrGameNotFound) {
		t.Fatalf("expected ErrGameNotFound, got %v", err)
	}

	// Stop
	stopRes, err := svc.StopSession()
	if err != nil {
		t.Fatalf("unexpected error stopping session: %v", err)
	}
	if stopRes.State != StateIdle {
		t.Fatalf("expected idle state, got %s", stopRes.State)
	}
}
