// bridge.go: SSE event bus between the Go binary and any open browser
// tabs. Pushes mode-change notifications, inbound network verbs (client
// mode), and session events (manager mode) to all subscribers.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

type sseEvent struct {
	Name string
	Data any
}

type sseSubscriber struct {
	ch chan sseEvent
}

type eventBus struct {
	mu   sync.Mutex
	subs map[*sseSubscriber]struct{}
}

func newEventBus() *eventBus {
	return &eventBus{subs: make(map[*sseSubscriber]struct{})}
}

// Publish fans an event out to every subscriber. Drops the event for any
// subscriber whose buffer is full (browser tab can't keep up) rather than
// blocking the publisher.
func (b *eventBus) Publish(name string, data any) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for s := range b.subs {
		select {
		case s.ch <- sseEvent{Name: name, Data: data}:
		default:
		}
	}
}

func (b *eventBus) subscribe() *sseSubscriber {
	s := &sseSubscriber{ch: make(chan sseEvent, 64)}
	b.mu.Lock()
	b.subs[s] = struct{}{}
	b.mu.Unlock()
	return s
}

func (b *eventBus) unsubscribe(s *sseSubscriber) {
	b.mu.Lock()
	delete(b.subs, s)
	b.mu.Unlock()
	close(s.ch)
}

// HandleSSE serves the /api/session/events SSE stream. Browser tabs
// EventSource onto this; each tab gets its own subscription. Sends a
// keepalive comment every 30s so idle proxies don't drop the connection.
func (b *eventBus) HandleSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	flusher.Flush()

	sub := b.subscribe()
	defer b.unsubscribe(sub)

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case ev, ok := <-sub.ch:
			if !ok {
				return
			}
			data, err := json.Marshal(ev.Data)
			if err != nil {
				log.Printf("sse marshal: %v", err)
				continue
			}
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Name, data); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}
