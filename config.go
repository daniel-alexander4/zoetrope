package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sync"
)

type Config struct {
	Mode               string          `json:"mode"` // "balls" or "field"
	Background         string          `json:"background"`
	BallSize           float64         `json:"ballSize"`
	Speed              float64         `json:"speed"`              // 0-10 scale; 10 = 1 cycle/sec for continuous patterns; for position-sequence patterns, 2 = nominal (configured) timings, higher = faster
	LingerSec          float64         `json:"lingerSec"`          // dwell at each extreme of a linear sweep; 0 = off
	LingerLeadFrac     float64         `json:"lingerLeadFrac"`     // how far the size pulse leads into adjacent motion, as a fraction of min(L, half); 0 = pulse confined to dwell
	ShowPositionLabels bool            `json:"showPositionLabels"` // when on, position-sequence patterns draw small labels at each gaze grid point
	Field              FieldConfig     `json:"field"`
	Playlists          []NamedPlaylist `json:"playlists"`
	ActivePlaylist     string          `json:"activePlaylist"`     // name of the playlist the engine plays; falls back to playlists[0] when missing
	UpdateCheckEnabled bool            `json:"updateCheckEnabled"` // opt-in: when on, the version pill checks GitHub releases for a newer version. Default off — the only sanctioned outbound call besides openBrowser.
}

type NamedPlaylist struct {
	Name     string         `json:"name"`
	Category string         `json:"category"`          // grouping label in the picker (e.g. "Continuous", "IEMT", "EMDR")
	Builtin  bool           `json:"builtin,omitempty"` // ships in defaultConfig; read-only in the editor. Duplicate to make an editable copy.
	Loop     bool           `json:"loop"`              // true → cycle back to the first item after the last; false → rewind to the start and stop
	Items    []PlaylistItem `json:"items"`
}

type FieldConfig struct {
	Speed            float64 `json:"speed"`            // 0-10 scale; controls intro pacing and steady-state flow
	Palette          string  `json:"palette"`          // named preset: Happy / Calm / Neon / Fire / Ocean
	Shape            string  `json:"shape"`            // circles / squares / diamonds / stripes / spiral / star / random
	ShuffleColors    bool    `json:"shuffleColors"`    // permute palette order each time the seed is rolled
	RandomSeed       int     `json:"randomSeed"`       // shared seed for random shape + palette shuffle; click "regenerate" to roll a new one
	Loop             bool    `json:"loop"`             // cycle: resolve to HD, hold, de-resolve back, repeat (re-rolling random/shuffle seeds each cycle)
	ShapeDurationSec float64 `json:"shapeDurationSec"` // total length of one resolve-hold-deresolve cycle when looping
}

type PlaylistItem struct {
	Pattern   string  `json:"pattern"`
	Name      string  `json:"name,omitempty"` // optional human-readable label (overrides the pattern default in the editor / now-playing)
	Color     string  `json:"color"`
	Repeats   int     `json:"repeats"`
	Speed     float64 `json:"speed,omitempty"` // per-item speed override on the 0–10 scale; absent → follow the global config.speed
	Direction string  `json:"direction,omitempty"`
	AngleDeg  float64 `json:"angleDeg,omitempty"`
	// Serpentine + lightbulbs (lanes); serpentine-only (cornerRadius, startCorner):
	Lanes        int     `json:"lanes,omitempty"`        // raster lane count (2–8); absent → 3
	CornerRadius float64 `json:"cornerRadius,omitempty"` // serpentine U-turn roundness 0–1; absent → 0 (square)
	StartCorner  string  `json:"startCorner,omitempty"`  // serpentine start corner 'tl'/'tr'; absent → 'tl'
	BulbSize     float64 `json:"bulbSize,omitempty"`     // lightbulbs bulb radius 0–1; absent → 0.3
	// Position-sequence patterns only:
	Steps    []SequenceStep `json:"steps,omitempty"`
	DwellSec float64        `json:"dwellSec,omitempty"` // default per-step dwell time (seconds); 0 → 1.5s fallback in the engine
	// No omitempty: transit=0 is a meaningful value (instant jump = saccade
	// training). With omitempty an explicit 0 would drop from the JSON and
	// read back as the engine's 0.8s smooth-pursuit fallback, silently
	// breaking saccade playlists and the editor's transit=0 setting.
	TransitSec float64 `json:"transitSec"` // smooth-pursuit transit between steps (s); 0 = instant jump (saccade)
}

type SequenceStep struct {
	Position string `json:"position"` // named gaze target: center / up / down / lateral-l / lateral-r / up-l / up-r / down-l / down-r
}

func defaultConfig() Config {
	return Config{
		Mode:           "balls",
		Background:     "#0e0e16",
		BallSize:       80,
		Speed:          2,
		LingerLeadFrac: 0.35,
		Field: FieldConfig{
			Speed:            2,
			Palette:          "Happy",
			Shape:            "circles",
			ShapeDurationSec: 12,
		},
		ActivePlaylist: "Default",
		Playlists: []NamedPlaylist{
			{
				Name: "Default", Category: "Continuous", Loop: true,
				Items: []PlaylistItem{
					{Pattern: "h-sweep", Color: "#f5e0dc", Repeats: 3},
					{Pattern: "v-sweep", Color: "#f9e2af", Repeats: 3},
					{Pattern: "diag-ulbr", Color: "#fab387", Repeats: 3},
					{Pattern: "diag-urbl", Color: "#eba0ac", Repeats: 3},
					{Pattern: "circle", Color: "#a6e3a1", Repeats: 3, Direction: "cw"},
					{Pattern: "infinity-h", Color: "#89b4fa", Repeats: 3, Direction: "cw"},
					{Pattern: "infinity-v", Color: "#cba6f7", Repeats: 3, Direction: "cw"},
					{Pattern: "bounce", Color: "#f38ba8", Repeats: 1, AngleDeg: 37},
				},
			},
			{
				Name: "IEMT · Identity (draft)", Category: "IEMT", Builtin: true, Loop: true,
				Items: []PlaylistItem{
					{
						Pattern: "position-sequence", Name: "IEMT · Identity",
						Color: "#b4befe", Repeats: 1, DwellSec: 1.5, TransitSec: 0.8,
						Steps: []SequenceStep{
							{Position: "up"}, {Position: "center"},
							{Position: "down"}, {Position: "center"},
							{Position: "lateral-l"}, {Position: "center"},
							{Position: "lateral-r"}, {Position: "center"},
							{Position: "up-l"}, {Position: "center"},
							{Position: "up-r"}, {Position: "center"},
							{Position: "down-l"}, {Position: "center"},
							{Position: "down-r"}, {Position: "center"},
						},
					},
				},
			},
			{
				Name: "IEMT · Emotion (draft)", Category: "IEMT", Builtin: true, Loop: true,
				Items: []PlaylistItem{
					{
						Pattern: "position-sequence", Name: "IEMT · Emotion",
						Color: "#f5c2e7", Repeats: 1, DwellSec: 1.5, TransitSec: 0.8,
						Steps: []SequenceStep{
							{Position: "up"}, {Position: "up-r"},
							{Position: "lateral-r"}, {Position: "down-r"},
							{Position: "down"}, {Position: "down-l"},
							{Position: "lateral-l"}, {Position: "up-l"},
						},
					},
				},
			},
			{
				Name: "EMDR · Horizontal (draft)", Category: "EMDR", Builtin: true, Loop: false,
				Items: []PlaylistItem{
					{Pattern: "h-sweep", Name: "EMDR · Bilateral set", Color: "#74c7ec", Repeats: 24, Speed: 6},
				},
			},
			{
				Name: "Saccades (draft)", Category: "Saccades", Builtin: true, Loop: true,
				Items: []PlaylistItem{
					{
						Pattern: "position-sequence", Name: "Saccades · Horizontal",
						Color: "#f9e2af", Repeats: 8, DwellSec: 0.5, TransitSec: 0,
						Steps: []SequenceStep{{Position: "lateral-l"}, {Position: "lateral-r"}},
					},
					{
						Pattern: "position-sequence", Name: "Saccades · Vertical",
						Color: "#f9e2af", Repeats: 8, DwellSec: 0.5, TransitSec: 0,
						Steps: []SequenceStep{{Position: "up"}, {Position: "down"}},
					},
				},
			},
			{
				Name: "Anti-saccade (draft)", Category: "Saccades", Builtin: true, Loop: true,
				Items: []PlaylistItem{
					{
						Pattern: "position-sequence", Name: "Anti-saccade · look away from the dot",
						Color: "#fab387", Repeats: 8, DwellSec: 0.5, TransitSec: 0,
						Steps: []SequenceStep{{Position: "lateral-l"}, {Position: "lateral-r"}},
					},
				},
			},
			{
				Name: "Smooth Pursuit (draft)", Category: "Pursuit", Builtin: true, Loop: true,
				Items: []PlaylistItem{
					{Pattern: "circle", Color: "#a6e3a1", Repeats: 3, Direction: "cw"},
					{Pattern: "infinity-h", Color: "#89b4fa", Repeats: 3, Direction: "cw"},
					{Pattern: "infinity-v", Color: "#cba6f7", Repeats: 3, Direction: "cw"},
					{Pattern: "fig8-h", Color: "#89dceb", Repeats: 3, Direction: "cw"},
				},
			},
		},
	}
}

func configFilePath(app string) (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, app, "config.json"), nil
}

type configStore struct {
	path string
	mu   sync.RWMutex
	cfg  Config
}

func newConfigStore(path string) (*configStore, error) {
	s := &configStore{path: path}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *configStore) load() error {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		s.cfg = defaultConfig()
		return s.save(s.cfg)
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", s.path, err)
	}
	cfg := defaultConfig()
	if err := json.Unmarshal(data, &cfg); err != nil {
		// Corrupt config: keep running on defaults rather than refusing to
		// start. The bad file stays on disk (left for inspection); the next
		// save from the editor overwrites it — no manual delete required.
		log.Printf("config %s is unparseable (%v); using defaults", s.path, err)
		s.cfg = defaultConfig()
		return nil
	}
	cfg.Playlists = reconcileBuiltins(cfg.Playlists)
	s.cfg = cfg
	return nil
}

// reconcileBuiltins makes the Builtin:true playlists genuinely code-owned. A
// JSON array unmarshal replaces the whole playlists slice with the on-disk
// one, so builtins added to defaultConfig() after a config was first saved
// never appear. This keeps the user's own (non-builtin) playlists exactly as
// saved, refreshes each persisted builtin from defaultConfig() by name, drops
// builtins the code no longer ships, and appends code builtins missing from
// the saved config. The Builtin flag only ever originates in defaultConfig()
// (duplicated/new playlists don't set it), so user playlists are never touched.
func reconcileBuiltins(saved []NamedPlaylist) []NamedPlaylist {
	codeByName := make(map[string]NamedPlaylist)
	var codeOrder []string
	for _, p := range defaultConfig().Playlists {
		if p.Builtin {
			codeByName[p.Name] = p
			codeOrder = append(codeOrder, p.Name)
		}
	}
	out := make([]NamedPlaylist, 0, len(saved)+len(codeOrder))
	used := make(map[string]bool)
	for _, p := range saved {
		if !p.Builtin {
			out = append(out, p) // user playlist — keep as-is
			continue
		}
		if cb, ok := codeByName[p.Name]; ok && !used[p.Name] {
			out = append(out, cb) // refresh persisted builtin from code
			used[p.Name] = true
		}
		// else: a builtin the code dropped, or a duplicate — discard
	}
	for _, name := range codeOrder {
		if !used[name] {
			out = append(out, codeByName[name]) // new builtin — append
			used[name] = true
		}
	}
	return out
}

func (s *configStore) Get() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

func (s *configStore) Set(cfg Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.save(cfg); err != nil {
		return err
	}
	s.cfg = cfg
	return nil
}

func (s *configStore) save(cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".config.*.tmp")
	if err != nil {
		return fmt.Errorf("create tmp: %w", err)
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write tmp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close tmp: %w", err)
	}
	if err := os.Rename(tmpPath, s.path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}
