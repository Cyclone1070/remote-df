package dto

// StartSessionRequest defines the payload required to start a game session.
type StartSessionRequest struct {
	GameID string   `json:"gameId" binding:"required" example:"dwarf-fortress"`
	Args   []string `json:"args,omitempty" example:"[]"`
}
