package config

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cyclone1070/remote-df/server/features/config/dto"
)

func TestConfigController_GetConfig(t *testing.T) {
	provider := &mockConfigProvider{
		cfg: ServerConfig{
			Mode:         "self-hosted",
			AuthRequired: false,
		},
	}
	service := NewConfigService(provider)
	ctrl := NewConfigController(service)

	req := httptest.NewRequest("GET", "/api/config", nil)
	w := httptest.NewRecorder()

	ctrl.GetConfig(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	var res dto.ConfigResponseDto
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if res.Mode != "self-hosted" {
		t.Fatalf("expected mode self-hosted, got %s", res.Mode)
	}
	if res.AuthRequired != false {
		t.Fatalf("expected authRequired false, got %v", res.AuthRequired)
	}
}
