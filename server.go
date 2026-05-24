package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"sync/atomic"
	"time"
)

//go:embed web/*
var webFS embed.FS

// csrfHeader is required on mutating endpoints. Browsers won't send a
// custom header from a cross-origin <form> submit without a preflight,
// and the server doesn't honor preflights from foreign origins — so the
// presence of this header is sufficient evidence the request came from
// our own JS, not from a page the user happened to visit while the
// server was running.
const csrfHeader = "X-Zoetrope"

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

func newRouter(store *configStore, hb *heartbeat) (http.Handler, error) {
	mux := http.NewServeMux()

	static, err := fs.Sub(webFS, "web")
	if err != nil {
		return nil, fmt.Errorf("sub-FS for web/: %w", err)
	}
	// Disable caching so a rebuilt binary always serves fresh JS/CSS to
	// the open browser tab.
	mux.Handle("/", noCache(http.FileServer(http.FS(static))))

	mux.HandleFunc("GET /config", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if err := json.NewEncoder(w).Encode(store.Get()); err != nil {
			log.Printf("encode /config: %v", err)
		}
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
		if r.Header.Get(csrfHeader) == "" {
			http.Error(w, "missing "+csrfHeader+" header", http.StatusForbidden)
			return
		}
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

	return mux, nil
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}
