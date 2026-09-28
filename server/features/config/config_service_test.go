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
			AuthRequired: false,
			StreamPort:   8485,
		},
	}

	service := NewConfigService(provider)
	res := service.GetServerConfig()

	if res.AuthRequired != false {
		t.Fatalf("expected authRequired false, got %v", res.AuthRequired)
	}
	if res.StreamPort != 8485 {
		t.Fatalf("expected streamPort 8485, got %d", res.StreamPort)
	}
}
