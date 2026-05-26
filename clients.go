// clients.go: persistent client + session records — the practitioner's
// local clinical-record store. Single source of truth for the on-disk
// schema; mode.go and server.go call in here for every read and write.
//
// Layout under <user-config>/zoetrope/clients/:
//
//	clients/
//	  <slug>/                        one dir per client
//	                                 slug = sanitized name + short random suffix
//	    client.json                  {id, name, createdAt}
//	    notes.md                     rolling notes; practitioner-owned, no auto-edits
//	    sessions/
//	      2026-05-25T19-32-00/       one dir per WS-paired session
//	        meta.json                {id, startedAt, endedAt, durationSec, sessionCertFP}
//
// Atomic writes mirror configStore: temp file + rename. Dir perms 0700,
// files 0600. No encryption at rest in v1 — relies on OS file permissions
// and is documented in the README. Self-healing on damaged entries: the
// list / load helpers skip them rather than panicking.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type ClientRecord struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

type SessionRecord struct {
	ID            string     `json:"id"` // = StartedAt slug (e.g. "2026-05-25T19-32-00")
	StartedAt     time.Time  `json:"startedAt"`
	EndedAt       *time.Time `json:"endedAt,omitempty"`
	DurationSec   int64      `json:"durationSec"`
	SessionCertFP string     `json:"sessionCertFP"`
}

type ClientView struct {
	ClientRecord
	Notes    string          `json:"notes"`
	Sessions []SessionRecord `json:"sessions"`
}

type ClientSummary struct {
	ClientRecord
	SessionCount int `json:"sessionCount"`
}

type clientsStore struct {
	mu  sync.Mutex
	dir string
}

func newClientsStore(rootDir string) (*clientsStore, error) {
	dir := filepath.Join(rootDir, "clients")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", dir, err)
	}
	return &clientsStore{dir: dir}, nil
}

// clientsRootDir returns the parent dir for all of zoetrope's user-state
// (config.json, practitioner_identity.pem, clients/...). Mirrors the
// configFilePath helper's location strategy.
func clientsRootDir(app string) (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, app), nil
}

func (s *clientsStore) List() ([]ClientSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]ClientSummary, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		rec, err := s.loadClientRecord(e.Name())
		if err != nil {
			continue // damaged entries are skipped; self-healing
		}
		count, _ := s.countSessions(e.Name())
		out = append(out, ClientSummary{ClientRecord: rec, SessionCount: count})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *clientsStore) Create(name string) (ClientRecord, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return ClientRecord{}, errors.New("name required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.uniqueSlug(name)
	rec := ClientRecord{
		ID:        id,
		Name:      name,
		CreatedAt: time.Now(),
	}
	if err := os.MkdirAll(filepath.Join(s.dir, id, "sessions"), 0o700); err != nil {
		return ClientRecord{}, err
	}
	if err := s.writeJSON(filepath.Join(s.dir, id, "client.json"), rec); err != nil {
		return ClientRecord{}, err
	}
	if err := s.writeFile(filepath.Join(s.dir, id, "notes.md"), nil); err != nil {
		return ClientRecord{}, err
	}
	return rec, nil
}

// Get returns the full view of a client: its record, notes, and session
// list (newest first). Errors if the client doesn't exist.
func (s *clientsStore) Get(id string) (ClientView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, err := s.loadClientRecord(id)
	if err != nil {
		return ClientView{}, err
	}
	notes, _ := os.ReadFile(filepath.Join(s.dir, id, "notes.md"))
	sessions, _ := s.loadSessions(id)
	return ClientView{ClientRecord: rec, Notes: string(notes), Sessions: sessions}, nil
}

// Exists reports whether a client record is present on disk. Used by
// mode.go to validate client_id on session creation before binding.
func (s *clientsStore) Exists(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.loadClientRecord(id)
	return err == nil
}

func (s *clientsStore) SaveNotes(id, notes string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.loadClientRecord(id); err != nil {
		return err
	}
	return s.writeFile(filepath.Join(s.dir, id, "notes.md"), []byte(notes))
}

// BeginSession creates a new session log entry and returns its ID. mode.go
// calls this once a WS pairs to a session whose cert is bound to a client.
func (s *clientsStore) BeginSession(clientID, sessionCertFP string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.loadClientRecord(clientID); err != nil {
		return "", err
	}
	now := time.Now()
	base := now.UTC().Format("2006-01-02T15-04-05")
	sid := base
	sessDir := filepath.Join(s.dir, clientID, "sessions", sid)
	for i := 1; ; i++ {
		if err := os.Mkdir(sessDir, 0o700); err == nil {
			break
		} else if !errors.Is(err, fs.ErrExist) {
			return "", err
		}
		sid = fmt.Sprintf("%s-%d", base, i)
		sessDir = filepath.Join(s.dir, clientID, "sessions", sid)
	}
	rec := SessionRecord{ID: sid, StartedAt: now, SessionCertFP: sessionCertFP}
	if err := s.writeJSON(filepath.Join(sessDir, "meta.json"), rec); err != nil {
		return "", err
	}
	return sid, nil
}

// InboxEntry is the on-disk record for one received file. The blob is
// stored alongside in <clientDir>/inbox/<id>/blob; meta.json carries
// everything the UI needs to list the entry without reading the blob.
type InboxEntry struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	MIME       string    `json:"mime,omitempty"`
	SizeBytes  int64     `json:"size_bytes"`
	ReceivedAt time.Time `json:"received_at"`
	SourceFP   string    `json:"source_fp,omitempty"`
}

// InboxAdd persists a received file under the client's dir. id is a
// sortable timestamp + 6-hex suffix so listings are naturally newest-
// first when reverse-sorted, and collisions are vanishingly rare.
func (s *clientsStore) InboxAdd(clientID, name, mime string, data []byte, sourceFP string) (InboxEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.loadClientRecord(clientID); err != nil {
		return InboxEntry{}, err
	}
	now := time.Now()
	id := newInboxEntryID(now)
	entryDir := filepath.Join(s.dir, clientID, "inbox", id)
	for i := 1; ; i++ {
		if err := os.MkdirAll(entryDir, 0o700); err == nil {
			break
		} else if !errors.Is(err, fs.ErrExist) {
			return InboxEntry{}, err
		}
		// Same nanosecond collision (effectively impossible with the
		// random suffix, but defensive): bump and retry.
		id = fmt.Sprintf("%s-%d", id, i)
		entryDir = filepath.Join(s.dir, clientID, "inbox", id)
	}
	rec := InboxEntry{
		ID:         id,
		Name:       name,
		MIME:       mime,
		SizeBytes:  int64(len(data)),
		ReceivedAt: now,
		SourceFP:   sourceFP,
	}
	if err := s.writeJSON(filepath.Join(entryDir, "meta.json"), rec); err != nil {
		return InboxEntry{}, err
	}
	if err := s.writeFile(filepath.Join(entryDir, "blob"), data); err != nil {
		return InboxEntry{}, err
	}
	return rec, nil
}

// InboxList returns every persisted entry for a client, newest first.
// Damaged entries are skipped (self-healing, same shape as session
// listing).
func (s *clientsStore) InboxList(clientID string) ([]InboxEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.loadClientRecord(clientID); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(filepath.Join(s.dir, clientID, "inbox"))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]InboxEntry, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.dir, clientID, "inbox", e.Name(), "meta.json"))
		if err != nil {
			continue
		}
		var rec InboxEntry
		if err := json.Unmarshal(raw, &rec); err != nil {
			continue
		}
		out = append(out, rec)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ReceivedAt.After(out[j].ReceivedAt) })
	return out, nil
}

// InboxBlob serves the bytes of one entry plus its meta. The blob is
// not deleted on read — the UI fetches lazily and the practitioner
// dismisses explicitly via InboxDelete.
func (s *clientsStore) InboxBlob(clientID, entryID string) ([]byte, InboxEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.dir, clientID, "inbox", entryID)
	metaRaw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return nil, InboxEntry{}, err
	}
	var rec InboxEntry
	if err := json.Unmarshal(metaRaw, &rec); err != nil {
		return nil, InboxEntry{}, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "blob"))
	if err != nil {
		return nil, InboxEntry{}, err
	}
	return data, rec, nil
}

// InboxDelete removes one entry's directory. Best-effort cleanup; a
// surviving fragment is benign (List skips it on next read).
func (s *clientsStore) InboxDelete(clientID, entryID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.dir, clientID, "inbox", entryID)
	return os.RemoveAll(dir)
}

func newInboxEntryID(t time.Time) string {
	var b [3]byte
	_, _ = rand.Read(b[:])
	return t.UTC().Format("2006-01-02T15-04-05.000") + "-" + hex.EncodeToString(b[:])
}

// EndSession finalizes a session entry with endedAt + durationSec. Safe
// to call multiple times; later calls overwrite earlier endings.
func (s *clientsStore) EndSession(clientID, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	metaPath := filepath.Join(s.dir, clientID, "sessions", sessionID, "meta.json")
	raw, err := os.ReadFile(metaPath)
	if err != nil {
		return err
	}
	var rec SessionRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		return err
	}
	now := time.Now()
	rec.EndedAt = &now
	rec.DurationSec = int64(now.Sub(rec.StartedAt).Seconds())
	return s.writeJSON(metaPath, rec)
}

// ---- helpers -----------------------------------------------------------

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

// uniqueSlug builds a stable, filesystem-safe ID from a human name plus a
// short random suffix. The suffix ensures the slug doesn't collide with
// another client of the same name and stays stable through renames.
func (s *clientsStore) uniqueSlug(name string) string {
	base := slugRe.ReplaceAllString(strings.ToLower(name), "-")
	base = strings.Trim(base, "-")
	if base == "" {
		base = "client"
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	return base + "-" + hex.EncodeToString(b[:])
}

func (s *clientsStore) loadClientRecord(id string) (ClientRecord, error) {
	raw, err := os.ReadFile(filepath.Join(s.dir, id, "client.json"))
	if err != nil {
		return ClientRecord{}, err
	}
	var rec ClientRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		return ClientRecord{}, err
	}
	return rec, nil
}

func (s *clientsStore) countSessions(id string) (int, error) {
	entries, err := os.ReadDir(filepath.Join(s.dir, id, "sessions"))
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() {
			n++
		}
	}
	return n, nil
}

func (s *clientsStore) loadSessions(id string) ([]SessionRecord, error) {
	entries, err := os.ReadDir(filepath.Join(s.dir, id, "sessions"))
	if err != nil {
		return nil, err
	}
	out := make([]SessionRecord, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.dir, id, "sessions", e.Name(), "meta.json"))
		if err != nil {
			continue
		}
		var rec SessionRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			continue
		}
		out = append(out, rec)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.After(out[j].StartedAt) })
	return out, nil
}

func (s *clientsStore) writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return s.writeFile(path, data)
}

func (s *clientsStore) writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp.*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}
