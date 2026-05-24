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
	Background      string         `json:"background"`
	SpeedMultiplier float64        `json:"speedMultiplier"`
	Playlist        []PlaylistItem `json:"playlist"`
}

type PlaylistItem struct {
	Pattern   string  `json:"pattern"`
	Color     string  `json:"color"`
	BallSize  float64 `json:"ballSize"`
	Duration  float64 `json:"duration"`
	Repeats   int     `json:"repeats"`
	Direction string  `json:"direction,omitempty"`
	AngleDeg  float64 `json:"angleDeg,omitempty"`
}

func defaultConfig() Config {
	return Config{
		Background:      "#0e0e16",
		SpeedMultiplier: 1.0,
		Playlist: []PlaylistItem{
			{Pattern: "h-sweep", Color: "#f5e0dc", BallSize: 24, Duration: 2.0, Repeats: 3},
			{Pattern: "v-sweep", Color: "#f9e2af", BallSize: 24, Duration: 2.0, Repeats: 3},
			{Pattern: "diag-ulbr", Color: "#fab387", BallSize: 24, Duration: 2.5, Repeats: 3},
			{Pattern: "diag-urbl", Color: "#eba0ac", BallSize: 24, Duration: 2.5, Repeats: 3},
			{Pattern: "circle", Color: "#a6e3a1", BallSize: 24, Duration: 3.0, Repeats: 3, Direction: "cw"},
			{Pattern: "infinity-h", Color: "#89b4fa", BallSize: 24, Duration: 4.0, Repeats: 3, Direction: "cw"},
			{Pattern: "infinity-v", Color: "#cba6f7", BallSize: 24, Duration: 4.0, Repeats: 3, Direction: "cw"},
			{Pattern: "bounce", Color: "#f38ba8", BallSize: 24, Duration: 6.0, Repeats: 1, AngleDeg: 37},
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
	var cfg Config
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
