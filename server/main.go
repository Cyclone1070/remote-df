package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/cyclone1070/remote-df/server/features/config"
	"github.com/cyclone1070/remote-df/server/features/games"
	"github.com/cyclone1070/remote-df/server/features/session"
	"github.com/cyclone1070/remote-df/server/infrastructure/web"
)

// @title           Remote-DF Hub Server API
// @version         0.1.0
// @description     Enterprise-grade self-hosted game streaming hub and process supervisor.
// @host            localhost:8484
// @BasePath        /

type appConfigProvider struct {
	cfg config.ServerConfig
}

func (p *appConfigProvider) GetConfig() config.ServerConfig {
	return p.cfg
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}

func getEnvBool(key string, fallback bool) bool {
	if v := os.Getenv(key); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return fallback
}

func main() {
	port := flag.Int("port", getEnvInt("PORT", 8484), "Public HTTP/WS server port")
	streamPort := flag.Int("stream-port", getEnvInt("STREAM_PORT", 8485), "Internal game stream port")
	headless := flag.Bool("headless", getEnvBool("HEADLESS", false), "Run as pure headless API server (no UI routes)")
	flag.Parse()

	log.Printf("Starting Remote-DF Server on :%d (headless: %v)...", *port, *headless)

	// Composition Root: Wire up Dependency Injection
	configProvider := &appConfigProvider{
		cfg: config.ServerConfig{
			AuthRequired: false,
			StreamPort:   *streamPort,
		},
	}
	gameRegistry := games.NewCatalogRegistry()
	supervisor := session.NewProcessSupervisor()

	// Services (Domain Logic with Injected Dependencies)
	configService := config.NewConfigService(configProvider)
	gamesService := games.NewGamesService(gameRegistry)
	sessionService := session.NewSessionService(supervisor, gameRegistry, *streamPort)

	// Controllers (HTTP Handlers Injected with Services)
	configCtrl := config.NewConfigController(configService)
	gamesCtrl := games.NewGamesController(gamesService)
	sessionCtrl := session.NewSessionController(sessionService)

	// Root Router
	mux := http.NewServeMux()
	configCtrl.RegisterRoutes(mux)
	gamesCtrl.RegisterRoutes(mux)
	sessionCtrl.RegisterRoutes(mux)

	// Stream Proxy: reverse-proxy WebSocket /ws to internal game streamer
	web.RegisterStreamProxy(mux, *streamPort)

	// UI Router: No-op in headless builds/flags; serves embedded React assets when built with -tags embed_ui
	web.RegisterUIRoutes(mux, *headless)

	server := &http.Server{
		Addr:    fmt.Sprintf(":%d", *port),
		Handler: mux,
	}

	// Graceful shutdown handling
	stopChan := make(chan os.Signal, 1)
	signal.Notify(stopChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	<-stopChan
	log.Println("Shutting down Remote-DF Server...")

	// Cleanly stop any active game session on server exit
	_ = supervisor.Stop()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Printf("Server forced shutdown error: %v", err)
	}

	log.Println("Remote-DF Server exited cleanly.")
}
