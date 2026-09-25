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
	"github.com/cyclone1070/remote-df/server/infrastructure/streamer"
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

func main() {
	port := flag.Int("port", getEnvInt("PORT", 8484), "Public HTTP/WS server port")
	streamPort := flag.Int("stream-port", getEnvInt("STREAM_PORT", 8485), "Internal game stream port")
	gamesDir := flag.String("games-dir", getEnv("GAMES_DIR", "/app/games"), "Directory containing game manifests")
	clientDir := flag.String("client-dir", getEnv("WEB_ROOT", "/app/client"), "Directory containing static frontend assets")
	mode := flag.String("mode", getEnv("MODE", "self-hosted"), "Deployment mode: self-hosted, native, saas")
	flag.Parse()

	log.Printf("Starting Remote-DF Server on :%d (mode: %s)...", *port, *mode)

	// Composition Root: Wire up Dependency Injection
	configProvider := &appConfigProvider{
		cfg: config.ServerConfig{
			Mode:         *mode,
			AuthRequired: false,
		},
	}
	gameRegistry := games.NewFileSystemRegistry(*gamesDir)
	supervisor := session.NewProcessSupervisor()

	// Services (Domain Logic with Injected Dependencies)
	configService := config.NewConfigService(configProvider)
	gamesService := games.NewGamesService(gameRegistry)
	sessionService := session.NewSessionService(supervisor, gameRegistry, *streamPort)

	// Controllers (HTTP Handlers Injected with Services)
	configCtrl := config.NewConfigController(configService)
	gamesCtrl := games.NewGamesController(gamesService)
	sessionCtrl := session.NewSessionController(sessionService)

	// Infrastructure Adapters
	streamerProxy := streamer.NewStreamerProxy(*streamPort)
	spaRouter := web.NewSPARouter(*clientDir)

	// Root Router
	mux := http.NewServeMux()
	configCtrl.RegisterRoutes(mux)
	gamesCtrl.RegisterRoutes(mux)
	sessionCtrl.RegisterRoutes(mux)
	streamerProxy.RegisterRoutes(mux)
	spaRouter.RegisterRoutes(mux) // Fallback for static assets & SPA routes

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
