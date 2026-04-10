package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/coder/acp-go-sdk"
	"github.com/halfwhey/allagent/pkg/acpbridge"
)

func main() {
	// Open log file before anything else so we can capture crashes.
	logFile, err := openLogFile()
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to open log file: %v\n", err)
		os.Exit(1)
	}
	defer logFile.Close()

	// Log to both the file and stderr. Stdout is reserved for ACP JSON-RPC.
	w := io.MultiWriter(os.Stderr, logFile)

	model := flag.String("model", "sonnet", "Claude model to use")
	debug := flag.Bool("debug", false, "Enable debug logging")
	flag.Parse()

	level := slog.LevelInfo
	if *debug {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: level}))

	logger.Info("allagent starting",
		"transport", "stdio",
		"model", *model,
		"pid", os.Getpid(),
	)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	agent := acpbridge.New(*model)
	agent.SetLogger(logger)

	conn := acp.NewAgentSideConnection(agent, os.Stdout, os.Stdin)
	conn.SetLogger(logger)
	agent.SetAgentConnection(conn)

	logger.Info("acp server ready", "protocol", "ACP/1", "waiting", "client initialize")

	select {
	case <-conn.Done():
		logger.Info("client disconnected")
	case <-ctx.Done():
		logger.Info("interrupted, shutting down")
	}

	agent.Shutdown()
	logger.Info("allagent stopped")
}

func openLogFile() (*os.File, error) {
	dir := "/tmp/allagent"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	name := fmt.Sprintf("%s/%s.log", dir, time.Now().Format("2006-01-02T15-04-05"))
	return os.OpenFile(name, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
}
