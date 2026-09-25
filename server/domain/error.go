package domain

// ErrorResponse represents a standardized cross-slice API error envelope.
type ErrorResponse struct {
	Error string `json:"error" example:"resource not found"`
}
