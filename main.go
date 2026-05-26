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
	"path/filepath"
	"runtime"
	"strconv"
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
		log.Fatalf("locate config dir: %v", err)
	}
	store, err := newConfigStore(configPath)
	if err != nil {
		log.Fatalf("init config: %v", err)
	}

	hb := &heartbeat{}
	bus := newEventBus()
	modes := newModeState(appName, bus, store)
	mux, err := newRouter(store, hb, bus, modes)
	if err != nil {
		log.Fatalf("router: %v", err)
	}

	// Prefer a stable port so a stale browser tab still points at the
	// live server after a restart. Before binding, ask any prior zoetrope
	// holding the port to exit — keeps a fresh launch on the canonical
	// port even when the previous binary outlived its browser tab. If
	// kill-prior fails or the port is taken by something else entirely,
	// fall back to a random free port so we still come up.
	const preferredPort = "38129"
	pidPath, _ := pidFilePath(appName)
	if pidPath != "" {
		killPriorInstance(pidPath, "127.0.0.1:"+preferredPort)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+preferredPort)
	if err != nil {
		log.Printf("port %s unavailable (%v); using random free port", preferredPort, err)
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			log.Fatalf("listen: %v", err)
		}
	}
	if pidPath != "" {
		if err := writePidFile(pidPath); err != nil {
			log.Printf("write pid file: %v", err)
		}
		defer os.Remove(pidPath)
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

	watchdogQuit := make(chan struct{})
	watchdogStop := make(chan struct{})
	defer close(watchdogStop)
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				modes.sweepTransfers()
				if modes.ShouldShutdown(hb) {
					close(watchdogQuit)
					return
				}
			case <-watchdogStop:
				return
			}
		}
	}()

	select {
	case err := <-serverErr:
		if err != nil {
			log.Fatalf("server: %v", err)
		}
	case sig := <-sigCh:
		log.Printf("received %s, shutting down", sig)
		modes.Standalone()
		shutdownServer(srv)
	case <-watchdogQuit:
		log.Printf("idle shutdown (mode=%s)", modes.Mode())
		modes.Standalone()
		shutdownServer(srv)
	}
}

func shutdownServer(srv *http.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

// pidFilePath puts the lock-file next to config.json in the user config
// dir, so it survives across launches and is naturally per-user.
func pidFilePath(app string) (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, app, app+".pid"), nil
}

func writePidFile(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())), 0o644)
}

// killPriorInstance reads the PID file; if it points at a live zoetrope
// process, SIGTERM it and wait up to ~5s for the port to free. Best-
// effort — silently no-ops if the file is missing, stale, points at an
// unrelated process, or the OS doesn't let us check identity.
func killPriorInstance(pidPath, addr string) {
	data, err := os.ReadFile(pidPath)
	if err != nil {
		return // no file (first run or already cleaned)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 || pid == os.Getpid() {
		return
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	// Signal(0) is a liveness probe on Unix; on Windows os.FindProcess
	// errors if the PID isn't valid, so reaching here implies the
	// process exists.
	if runtime.GOOS != "windows" {
		if err := proc.Signal(syscall.Signal(0)); err != nil {
			return // dead — stale pid file
		}
	}
	if !pidLooksLikeZoetrope(pid) {
		return // PID has been reused by an unrelated process
	}
	log.Printf("killing prior zoetrope instance (pid %d) to reclaim %s", pid, addr)
	_ = proc.Signal(syscall.SIGTERM)
	// Poll the port — return as soon as it frees. ~5s ceiling.
	for i := 0; i < 25; i++ {
		time.Sleep(200 * time.Millisecond)
		l, err := net.Listen("tcp", addr)
		if err == nil {
			l.Close()
			return
		}
	}
}

// pidLooksLikeZoetrope verifies the PID belongs to a zoetrope process so
// a stale pid file pointing at a reused PID doesn't make us SIGTERM an
// unrelated program. Linux uses /proc/<pid>/comm; other OSes trust the
// pid file because cross-platform process introspection is messy and
// the worst case (SIGTERM to a reused PID) is rare and recoverable.
func pidLooksLikeZoetrope(pid int) bool {
	if runtime.GOOS != "linux" {
		return true
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(data)) == appName
}
