package logging

import (
	"log"
	"os"
)

// Logger provides structured prefix-based logging for feature slices and services.
type Logger struct {
	*log.Logger
	prefix string
}

// NewLogger instantiates a service logger with standardized prefixing.
func NewLogger(serviceName string) *Logger {
	return &Logger{
		Logger: log.New(os.Stdout, "["+serviceName+"] ", log.LstdFlags),
		prefix: serviceName,
	}
}
