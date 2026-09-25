package config

import (
	"testing"
)

type mockConfigProvider struct {
	cfg ServerConfig
}

func (m *mockConfigProvider) GetConfig() ServerConfig {
	return m.cfg
}

func TestConfigService_GetServerConfig(t *testing.T) {
	provider := &mockConfigProvider{
		cfg: ServerConfig{
			Mode:         "self-hosted",
			AuthRequired: false,
		},
	}

	service := NewConfigService(provider)
	res := service.GetServerConfig()

	if res.Mode != "self-hosted" {
		t.Fatalf("expected mode self-hosted, got %s", res.Mode)
	}
	if res.AuthRequired != false {
		t.Fatalf("expected authRequired false, got %v", res.AuthRequired)
	}
}
