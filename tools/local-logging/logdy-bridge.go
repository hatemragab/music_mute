// The pinned upstream library supplies the UI, file follower and bounded log
// buffer. Its HTTP server is exposed only through a private Unix-domain socket.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	logdyhttp "github.com/logdyhq/logdy-core/http"
	"github.com/logdyhq/logdy-core/logdy"
	"github.com/logdyhq/logdy-core/models"
	"github.com/logdyhq/logdy-core/modes"
	"github.com/nxadm/tail"
)

type settings struct {
	SocketPath string `json:"socketPath"`
	LogFile    string `json:"logFile"`
	LayoutFile string `json:"layoutFile"`
}

func run() error {
	var config settings
	if err := json.NewDecoder(os.Stdin).Decode(&config); err != nil {
		return errors.New("could not read viewer settings")
	}
	if config.SocketPath == "" || config.LogFile == "" || config.LayoutFile == "" {
		return errors.New("incomplete viewer settings")
	}
	if _, err := os.Lstat(config.SocketPath); !os.IsNotExist(err) {
		return errors.New("viewer socket already exists or cannot be checked")
	}
	mux := http.NewServeMux()
	logdy.InitializeLogdy(logdy.Config{
		// In v0.17.1 this field maps directly to AnalyticsDisabled. Keep true
		// until that upstream translation is corrected in a reviewed upgrade.
		AnalyticsEnabled: true,
		ConfigFilePath:   config.LayoutFile,
		BulkWindowMs:     100,
		MaxMessageCount:  2000,
		LogLevel:         logdy.LOG_LEVEL_SILENT,
	}, mux)
	listener, err := net.Listen("unix", config.SocketPath)
	if err != nil {
		return errors.New("could not create the private viewer socket")
	}
	defer listener.Close()
	if err := os.Chmod(config.SocketPath, 0600); err != nil {
		return errors.New("could not secure the private viewer socket")
	}
	// A single reader starts at offset zero and keeps following. Separate
	// initial-read and seek-to-end operations would lose intervening appends.
	follower, err := tail.TailFile(config.LogFile, tail.Config{
		Follow: true,
		ReOpen: true,
		Location: &tail.SeekInfo{
			Offset: 0,
			Whence: io.SeekStart,
		},
		Logger: tail.DiscardingLogger,
	})
	if err != nil {
		return errors.New("could not follow the private log file")
	}
	defer follower.Stop()
	defer follower.Cleanup()
	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	go func() {
		for line := range follower.Lines {
			if line.Err != nil {
				continue
			}
			modes.ProduceMessageString(logdyhttp.Ch, line.Text, models.MessageTypeStdout, &models.MessageOrigin{File: config.LogFile})
		}
	}()
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return errors.New("viewer server stopped unexpectedly")
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		// Controlled errors exclude settings, payloads and low-level errors.
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}
