package main

import (
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"sync/atomic"
	"time"
)

//go:embed web/*
var webFS embed.FS

// heartbeat tracks the most recent client ping. Stale() returns false
// until the first ping arrives, so the server doesn't shut itself down
// before the browser ever connects.
type heartbeat struct {
	lastMs atomic.Int64
}

func (h *heartbeat) Touch() {
	h.lastMs.Store(time.Now().UnixMilli())
}

func (h *heartbeat) Stale(d time.Duration) bool {
	last := h.lastMs.Load()
	if last == 0 {
		return false
	}
	return time.Since(time.UnixMilli(last)) > d
}

func newRouter(store *configStore, hb *heartbeat) http.Handler {
	mux := http.NewServeMux()

	static, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	// Disable caching so a rebuilt binary always serves fresh JS/CSS to
	// the open browser tab.
	mux.Handle("/", noCache(http.FileServer(http.FS(static))))

	mux.HandleFunc("GET /config", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(store.Get())
	})

	mux.HandleFunc("POST /heartbeat", func(w http.ResponseWriter, r *http.Request) {
		hb.Touch()
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("GET /version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte("v" + version + "\n"))
	})

	mux.HandleFunc("PUT /config", func(w http.ResponseWriter, r *http.Request) {
		var cfg Config
		if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
			http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
			return
		}
		if err := store.Set(cfg); err != nil {
			http.Error(w, "save failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	return mux
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}
