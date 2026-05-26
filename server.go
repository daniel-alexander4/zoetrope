package main

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
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

func newRouter(store *configStore, hb *heartbeat, bus *eventBus, modes *modeState) (http.Handler, error) {
	mux := http.NewServeMux()

	static, err := fs.Sub(webFS, "web")
	if err != nil {
		return nil, fmt.Errorf("sub-FS for web/: %w", err)
	}
	// Disable caching so a rebuilt binary always serves fresh JS/CSS to
	// the open browser tab.
	mux.Handle("/", noCache(http.FileServer(http.FS(static))))

	// /manage is the hosting console — a second top-level page that
	// shares the same JS/CSS assets but has its own HTML root. Served
	// explicitly because http.FileServer won't resolve /manage to
	// manage.html on its own.
	mux.HandleFunc("GET /manage", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFileFS(w, r, static, "manage.html")
	})

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

	mux.HandleFunc("PUT /config", requireCSRF(func(w http.ResponseWriter, r *http.Request) {
		var cfg Config
		if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
			http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
			return
		}
		if err := store.Set(cfg); err != nil {
			http.Error(w, "save failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		// In manager mode, fan the fresh config to every connected
		// session so client-side edits (active playlist switch, global
		// tweaks) propagate without requiring a rejoin. No-op otherwise.
		modes.BroadcastConfig()
		w.WriteHeader(http.StatusNoContent)
	}))

	// ---- Mode + session endpoints ----
	mux.HandleFunc("GET /api/mode/state", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(modes.Snapshot())
	})
	mux.HandleFunc("POST /api/mode/host", requireCSRF(func(w http.ResponseWriter, r *http.Request) {
		var req hostRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
			return
		}
		if err := modes.Host(req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("POST /api/mode/join", requireCSRF(func(w http.ResponseWriter, r *http.Request) {
		var req joinRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
			return
		}
		if err := modes.Join(req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("POST /api/mode/standalone", requireCSRF(func(w http.ResponseWriter, r *http.Request) {
		modes.Standalone()
		w.WriteHeader(http.StatusNoContent)
	}))

	mux.HandleFunc("POST /api/sessions", requireCSRF(func(w http.ResponseWriter, r *http.Request) {
		url, snap, err := modes.CreateSession()
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"url":     url,
			"session": snap,
		})
	}))
	mux.HandleFunc("POST /api/sessions/quickstart", requireCSRF(func(w http.ResponseWriter, r *http.Request) {
		url, snap, err := modes.Quickstart()
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"url":     url,
			"session": snap,
		})
	}))
	mux.HandleFunc("DELETE /api/sessions/{fp}", requireCSRF(func(w http.ResponseWriter, r *http.Request) {
		fp := r.PathValue("fp")
		if err := modes.RemoveSession(fp); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("POST /api/sessions/{fp}/verb", requireCSRF(func(w http.ResponseWriter, r *http.Request) {
		fp := r.PathValue("fp")
		raw, err := readBoundedBody(r, 16*1024)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := modes.SendVerb(fp, raw); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	mux.HandleFunc("POST /api/network/send", requireCSRF(func(w http.ResponseWriter, r *http.Request) {
		var msg map[string]any
		if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
			http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
			return
		}
		if err := modes.ClientSend(msg); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	// ---- File transfer endpoints ----
	// Upload: browser POSTs the raw file bytes; Go chunks + sends over WS.
	// Inbox: receiver browser GETs to save/open; DELETEs to dismiss.

	mux.HandleFunc("POST /api/sessions/{fp}/transfer", requireCSRF(func(w http.ResponseWriter, r *http.Request) {
		handleOutboundTransfer(w, r, store, func(name, mime string, data []byte) (string, error) {
			return modes.SendFileToSession(r.PathValue("fp"), name, mime, data)
		})
	}))
	mux.HandleFunc("POST /api/network/transfer", requireCSRF(func(w http.ResponseWriter, r *http.Request) {
		handleOutboundTransfer(w, r, store, modes.SendFileToManager)
	}))
	mux.HandleFunc("GET /api/inbox/{id}", func(w http.ResponseWriter, r *http.Request) {
		entry, ok := modes.consumeInbox(r.PathValue("id"))
		if !ok {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		mime := entry.mime
		if mime == "" {
			mime = "application/octet-stream"
		}
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Content-Length", fmt.Sprint(len(entry.data)))
		// inline lets "Open" render previewable types in a new tab; the
		// "Save" path uses <a download="name"> to force a download with
		// the right filename. filename* gives browsers the original name
		// to suggest when the user does save from the inline view.
		w.Header().Set("Content-Disposition", "inline; filename*=UTF-8''"+url.PathEscape(entry.name))
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(entry.data)
	})
	mux.HandleFunc("DELETE /api/inbox/{id}", requireCSRF(func(w http.ResponseWriter, r *http.Request) {
		if !modes.dismissInbox(r.PathValue("id")) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	mux.HandleFunc("GET /api/session/events", bus.HandleSSE)

	return mux, nil
}

// handleOutboundTransfer reads a raw file body up to the local MaxTransferBytes
// cap, then hands it to the mode-specific sender (session-bound on the
// manager side, manager-bound on the client side).
func handleOutboundTransfer(w http.ResponseWriter, r *http.Request, store *configStore, send func(name, mime string, data []byte) (string, error)) {
	cap := store.Get().MaxTransferBytes
	if cap <= 0 {
		http.Error(w, "file transfer disabled (maxTransferBytes is 0)", http.StatusForbidden)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, cap)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			http.Error(w, fmt.Sprintf("file exceeds local cap of %d bytes", cap), http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}
	name := decodeFilenameHeader(r.Header.Get("X-Transfer-Filename"))
	mime := r.Header.Get("X-Transfer-Mime")
	if mime == "" {
		mime = "application/octet-stream"
	}
	id, err := send(name, mime, data)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"transfer_id": id,
		"name":        name,
		"size_bytes":  len(data),
	})
}

func requireCSRF(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(csrfHeader) == "" {
			http.Error(w, "missing "+csrfHeader+" header", http.StatusForbidden)
			return
		}
		handler(w, r)
	}
}

func readBoundedBody(r *http.Request, max int64) (json.RawMessage, error) {
	r.Body = http.MaxBytesReader(nil, r.Body, max)
	var raw json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("invalid json: %w", err)
	}
	return raw, nil
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}
