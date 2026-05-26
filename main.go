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
	// to exit — keeps a fresh launch on the canonical ports even when
	// the previous binary outlived its browser tab. Wait for both the
	// HTTP port (38129) and the manager mTLS port (38130) to free so a
	// subsequent Hosting click doesn't race against the old binary's
	// listener teardown. If a non-zoetrope process is camping on 38129
	// we fall back to a random free port so we still come up.
	const httpAddr = "127.0.0.1:38129"
	pidPath, _ := pidFilePath(appName)
	killPriorInstances(pidPath, httpAddr, managerListenAddr)
	ln, err := net.Listen("tcp", httpAddr)
	if err != nil {
		log.Printf("%s unavailable (%v); using random free port", httpAddr, err)
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

// killPriorInstances finds every running zoetrope process other than
// ourselves and asks it to exit, then waits up to ~5s for the given
// addrs to free. On Linux we walk /proc/*/comm so we catch prior
// binaries that didn't write a pid file (e.g. pre-singleton versions
// surviving a deb upgrade). On macOS/Windows we fall back to the pid
// file — best-effort; SIGTERM to a reused PID is rare and recoverable.
func killPriorInstances(pidPath string, waitAddrs ...string) {
	pids := findPriorPIDs(pidPath)
	if len(pids) == 0 {
		return
	}
	for _, pid := range pids {
		proc, err := os.FindProcess(pid)
		if err != nil {
			continue
		}
		log.Printf("killing prior zoetrope (pid %d)", pid)
		_ = proc.Signal(syscall.SIGTERM)
	}
	waitPortsFree(5*time.Second, waitAddrs...)
}

func findPriorPIDs(pidPath string) []int {
	self := os.Getpid()
	if runtime.GOOS == "linux" {
		return scanProcForZoetrope(self)
	}
	// Non-Linux: trust the pid file (no cheap cross-platform comm read).
	if pidPath == "" {
		return nil
	}
	data, err := os.ReadFile(pidPath)
	if err != nil {
		return nil
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 || pid == self {
		return nil
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return nil
	}
	if runtime.GOOS != "windows" {
		if err := proc.Signal(syscall.Signal(0)); err != nil {
			return nil // stale pid file
		}
	}
	return []int{pid}
}

// scanProcForZoetrope returns every PID whose /proc/<pid>/comm field is
// exactly "zoetrope", excluding self. comm is truncated to 15 chars by
// the kernel (TASK_COMM_LEN-1); "zoetrope" fits, so an exact match is
// safe.
func scanProcForZoetrope(self int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var pids []int
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 || pid == self {
			continue
		}
		data, err := os.ReadFile("/proc/" + e.Name() + "/comm")
		if err != nil {
			continue // process may have exited between ReadDir and now
		}
		if strings.TrimSpace(string(data)) == appName {
			pids = append(pids, pid)
		}
	}
	return pids
}

// waitPortsFree polls each addr until net.Listen succeeds, sharing one
// budget across all addrs. The manager-mode mTLS listener (:38130) lags
// the SIGTERM by ~1s while modes.Standalone() unwinds — without this we
// can race the prior binary and fail a later modes.Host() bind.
func waitPortsFree(budget time.Duration, addrs ...string) {
	deadline := time.Now().Add(budget)
	for _, addr := range addrs {
		for time.Now().Before(deadline) {
			l, err := net.Listen("tcp", addr)
			if err == nil {
				l.Close()
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
}
