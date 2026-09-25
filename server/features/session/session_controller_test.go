package session

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cyclone1070/remote-df/server/domain"
	"github.com/cyclone1070/remote-df/server/features/session/dto"
)

func TestSessionController_GetStatus(t *testing.T) {
	mockSup := &mockSupervisor{
		status: SessionStatus{State: StateIdle},
	}
	mockReg := &mockGameRegistry{manifests: map[string]domain.GameManifest{}}
	svc := NewSessionService(mockSup, mockReg, 8485)
	ctrl := NewSessionController(svc)

	req := httptest.NewRequest("GET", "/api/session", nil)
	w := httptest.NewRecorder()

	ctrl.GetStatus(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var status SessionStatus
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if status.State != StateIdle {
		t.Fatalf("expected idle state, got %s", status.State)
	}
}

func TestSessionController_StartSession_Success(t *testing.T) {
	mockSup := &mockSupervisor{
		status: SessionStatus{State: StateIdle},
	}
	mockReg := &mockGameRegistry{
		manifests: map[string]domain.GameManifest{
			"df": {ID: "df", Name: "Dwarf Fortress"},
		},
	}
	svc := NewSessionService(mockSup, mockReg, 8485)
	ctrl := NewSessionController(svc)

	body, _ := json.Marshal(dto.StartSessionRequest{GameID: "df"})
	req := httptest.NewRequest("POST", "/api/session/start", bytes.NewBuffer(body))
	w := httptest.NewRecorder()

	ctrl.StartSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var status SessionStatus
	_ = json.Unmarshal(w.Body.Bytes(), &status)
	if status.State != StateRunning {
		t.Fatalf("expected running, got %s", status.State)
	}
}

func TestSessionController_StartSession_NotFound(t *testing.T) {
	mockSup := &mockSupervisor{status: SessionStatus{State: StateIdle}}
	mockReg := &mockGameRegistry{manifests: map[string]domain.GameManifest{}}
	svc := NewSessionService(mockSup, mockReg, 8485)
	ctrl := NewSessionController(svc)

	body, _ := json.Marshal(dto.StartSessionRequest{GameID: "df"})
	req := httptest.NewRequest("POST", "/api/session/start", bytes.NewBuffer(body))
	w := httptest.NewRecorder()

	ctrl.StartSession(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestSessionController_StartSession_Conflict(t *testing.T) {
	mockSup := &mockSupervisor{
		status: SessionStatus{State: StateRunning, GameID: "df"},
	}
	mockReg := &mockGameRegistry{
		manifests: map[string]domain.GameManifest{
			"df": {ID: "df", Name: "Dwarf Fortress"},
		},
	}
	svc := NewSessionService(mockSup, mockReg, 8485)
	ctrl := NewSessionController(svc)

	body, _ := json.Marshal(dto.StartSessionRequest{GameID: "df"})
	req := httptest.NewRequest("POST", "/api/session/start", bytes.NewBuffer(body))
	w := httptest.NewRecorder()

	ctrl.StartSession(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", w.Code)
	}
}

func TestSessionController_StopSession(t *testing.T) {
	mockSup := &mockSupervisor{
		status: SessionStatus{State: StateRunning, GameID: "df"},
	}
	mockReg := &mockGameRegistry{manifests: map[string]domain.GameManifest{}}
	svc := NewSessionService(mockSup, mockReg, 8485)
	ctrl := NewSessionController(svc)

	req := httptest.NewRequest("POST", "/api/session/stop", nil)
	w := httptest.NewRecorder()

	ctrl.StopSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var status SessionStatus
	_ = json.Unmarshal(w.Body.Bytes(), &status)
	if status.State != StateIdle {
		t.Fatalf("expected idle, got %s", status.State)
	}
}
