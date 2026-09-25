package logging

import (
	"testing"
)

func TestNewLogger(t *testing.T) {
	logger := NewLogger("TestService")
	if logger == nil || logger.prefix != "TestService" {
		t.Fatalf("expected logger with prefix TestService")
	}
}
