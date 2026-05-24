package main

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const appName = "zoetrope"

//go:embed VERSION
var versionRaw string
var version = strings.TrimSpace(versionRaw)

func main() {
	log.SetFlags(log.Ltime)
	log.SetPrefix(appName + ": ")
	log.Printf("zoetrope v%s", version)

	configPath, err := configFilePath(appName)
	if err != nil {
		fatal("locate config dir: %v", err)
	}
	store, err := newConfigStore(configPath)
	if err != nil {
		fatal("init config: %v", err)
	}

	hb := &heartbeat{}
	mux := newRouter(store, hb)

	// Prefer a stable port so a stale browser tab still points at the
	// live server after a restart. Fall back to a random free port if
	// the preferred one is taken (e.g., another Zoetrope is running).
	const preferredPort = "38129"
	ln, err := net.Listen("tcp", "127.0.0.1:"+preferredPort)
	if err != nil {
		log.Printf("port %s unavailable (%v); using random free port", preferredPort, err)
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fatal("listen: %v", err)
		}
	}
	url := fmt.Sprintf("http://%s/", ln.Addr().String())
	log.Printf("listening on %s", url)
	log.Printf("config: %s", configPath)

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	serverErr := make(chan error, 1)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
		close(serverErr)
	}()

	if err := openBrowser(url); err != nil {
		log.Printf("could not auto-open browser (%v); open %s manually", err, url)
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	const heartbeatTimeout = 90 * time.Second
	watchdogQuit := make(chan struct{})
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if hb.Stale(heartbeatTimeout) {
				close(watchdogQuit)
				return
			}
		}
	}()

	select {
	case err := <-serverErr:
		if err != nil {
			fatal("server: %v", err)
		}
	case sig := <-sigCh:
		log.Printf("received %s, shutting down", sig)
		shutdown(srv)
	case <-watchdogQuit:
		log.Printf("no heartbeat for %v, shutting down", heartbeatTimeout)
		shutdown(srv)
	}
}

func shutdown(srv *http.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func fatal(format string, args ...any) {
	log.Printf(format, args...)
	os.Exit(1)
}
