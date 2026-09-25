package dto

// ConfigResponseDto defines the HTTP response payload for server configuration.
type ConfigResponseDto struct {
	Mode         string `json:"mode" example:"self-hosted"`
	AuthRequired bool   `json:"authRequired" example:"false"`
}
