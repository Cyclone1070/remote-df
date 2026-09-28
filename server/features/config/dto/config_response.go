package dto

// ConfigResponseDto defines the HTTP response payload for server configuration.
type ConfigResponseDto struct {
	AuthRequired bool `json:"authRequired" example:"false"`
	StreamPort   int  `json:"streamPort" example:"8485"`
}
