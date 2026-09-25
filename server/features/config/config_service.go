package config

import "github.com/cyclone1070/remote-df/server/features/config/dto"

// ConfigProvider defines the contract for accessing underlying server settings.
type ConfigProvider interface {
	GetConfig() ServerConfig
}

// ConfigService encapsulates business logic for retrieving server configuration.
type ConfigService struct {
	provider ConfigProvider
}

// NewConfigService constructs a new ConfigService with injected ConfigProvider.
func NewConfigService(provider ConfigProvider) *ConfigService {
	return &ConfigService{provider: provider}
}

// GetServerConfig returns the formatted configuration DTO.
func (s *ConfigService) GetServerConfig() dto.ConfigResponseDto {
	cfg := s.provider.GetConfig()
	return dto.ConfigResponseDto{
		Mode:         cfg.Mode,
		AuthRequired: cfg.AuthRequired,
	}
}
