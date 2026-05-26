package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

type Config struct {
	Mode               string         `json:"mode"` // "balls" or "field"
	Background         string         `json:"background"`
	BallSize           float64        `json:"ballSize"`
	Speed              float64        `json:"speed"`              // 0-10 scale; 10 = 1 cycle/sec for continuous patterns; for position-sequence patterns, 2 = nominal (configured) timings, higher = faster
	LingerSec          float64        `json:"lingerSec"`          // dwell at each extreme of a linear sweep; 0 = off
	LingerLeadFrac     float64        `json:"lingerLeadFrac"`     // how far the size pulse leads into adjacent motion, as a fraction of min(L, half); 0 = pulse confined to dwell
	ShowPositionLabels bool           `json:"showPositionLabels"` // when on, position-sequence patterns draw small labels at each gaze grid point
	Field              FieldConfig    `json:"field"`
	Playlist           []PlaylistItem `json:"playlist"`
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
	Direction string  `json:"direction,omitempty"`
	AngleDeg  float64 `json:"angleDeg,omitempty"`
	// Position-sequence patterns only:
	Steps      []SequenceStep `json:"steps,omitempty"`
	DwellSec   float64        `json:"dwellSec,omitempty"`   // default per-step dwell time (seconds); 0 → 1.5s fallback in the engine
	TransitSec float64        `json:"transitSec,omitempty"` // default smooth-pursuit transit time between steps (seconds); 0 → 0.8s fallback
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
		Playlist: []PlaylistItem{
			{Pattern: "h-sweep", Color: "#f5e0dc", Repeats: 3},
			{Pattern: "v-sweep", Color: "#f9e2af", Repeats: 3},
			{Pattern: "diag-ulbr", Color: "#fab387", Repeats: 3},
			{Pattern: "diag-urbl", Color: "#eba0ac", Repeats: 3},
			{Pattern: "circle", Color: "#a6e3a1", Repeats: 3, Direction: "cw"},
			{Pattern: "infinity-h", Color: "#89b4fa", Repeats: 3, Direction: "cw"},
			{Pattern: "infinity-v", Color: "#cba6f7", Repeats: 3, Direction: "cw"},
			{Pattern: "bounce", Color: "#f38ba8", Repeats: 1, AngleDeg: 37},
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
		return fmt.Errorf("parse %s: %w", s.path, err)
	}
	s.cfg = cfg
	return nil
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
