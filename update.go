package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Update check — the version pill's "check for updates" (ported from
// nib/hespera). It compares the running version to the newest published GitHub
// release and, when one is newer, reports the release asset matching this
// machine's OS/arch. It downloads nothing and installs nothing — the client
// navigates to the asset URL so the browser downloads it; installing is the
// user's step.
//
// This is the ONE sanctioned outbound call besides openBrowser, and it is
// gated server-side on the persisted UpdateCheckEnabled toggle (default off):
// with the toggle off the handler answers enabled:false without any network
// call, so no request ever leaves the machine unless the user opted in. See
// CLAUDE.md's Network section.

// githubLatestURL is GitHub's "latest release" API for Zoetrope. A package var
// so tests can point it at a stub. No releases are published there yet (the
// binary ships peer-to-peer), so until they are the check answers "no releases"
// and the pill stays in its unknown state.
var githubLatestURL = "https://api.github.com/repos/daniel-alexander4/zoetrope/releases/latest"

type updateResponse struct {
	Enabled     bool   `json:"enabled"` // false when the toggle is off (no check ran)
	Current     string `json:"current"`
	Latest      string `json:"latest,omitempty"` // empty when no release is published yet
	Available   bool   `json:"updateAvailable"`
	URL         string `json:"url,omitempty"`         // release page
	DownloadURL string `json:"downloadUrl,omitempty"` // asset matching this OS/arch, if present
	Managed     bool   `json:"managed"`               // installed under a system path — the asset is a .deb, not a raw binary
}

func updateCheckHandler(store *configStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resp := updateResponse{Enabled: true, Current: version, Managed: managedInstall()}
		if !store.Get().UpdateCheckEnabled {
			// Toggle off: no network call at all.
			resp.Enabled = false
			writeJSON(w, resp)
			return
		}
		rel, err := latestRelease(r.Context())
		if err != nil {
			http.Error(w, "could not reach the update server", http.StatusBadGateway)
			return
		}
		if rel != nil {
			resp.Latest = strings.TrimPrefix(rel.Tag, "v")
			resp.URL = rel.URL
			resp.Available = versionLess(resp.Current, resp.Latest)
			if resp.Available {
				resp.DownloadURL = assetURL(runtime.GOOS, runtime.GOARCH, resp.Managed, rel.Assets)
			}
		}
		writeJSON(w, resp)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("encode /update/check: %v", err)
	}
}

type release struct {
	Tag    string
	URL    string
	Assets []releaseAsset
}

type releaseAsset struct {
	Name string
	URL  string
}

// latestRelease returns Zoetrope's newest published release, or (nil, nil) when
// none exists yet (404 — which a repo with no releases also answers).
func latestRelease(ctx context.Context) (*release, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubLatestURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil // no releases published yet
	}
	if resp.StatusCode != http.StatusOK {
		return nil, errStatusCode(resp.StatusCode)
	}
	var raw struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
		Assets  []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&raw); err != nil {
		return nil, err
	}
	rel := &release{Tag: raw.TagName, URL: raw.HTMLURL}
	for _, a := range raw.Assets {
		rel.Assets = append(rel.Assets, releaseAsset{Name: a.Name, URL: a.URL})
	}
	return rel, nil
}

type errStatusCode int

func (e errStatusCode) Error() string { return "update server returned HTTP " + strconv.Itoa(int(e)) }

// assetURL picks the release asset for this OS/arch, matched to build.sh's
// artifact names (the single source for those names):
//   - darwin  → Zoetrope-<ver>-mac-universal.zip (one universal build, no arch)
//   - windows → Zoetrope-<ver>-windows-<arch>.exe
//   - linux   → Zoetrope-<ver>-linux-<arch>.deb   (managed / dpkg install)
//     zoetrope-<ver>-linux-<arch>        (standalone binary)
//
// Empty when nothing matches (the client falls back to the release page).
func assetURL(goos, goarch string, managed bool, assets []releaseAsset) string {
	for _, a := range assets {
		switch goos {
		case "darwin":
			if strings.Contains(a.Name, "-mac-universal") {
				return a.URL
			}
		case "windows":
			if strings.Contains(a.Name, "-windows-"+goarch) {
				return a.URL
			}
		default: // linux and friends
			if managed {
				if strings.HasSuffix(a.Name, "-linux-"+goarch+".deb") {
					return a.URL
				}
				continue
			}
			if strings.Contains(a.Name, "-linux-"+goarch) && !strings.HasSuffix(a.Name, ".deb") {
				return a.URL
			}
		}
	}
	return ""
}

// versionLess reports whether semver a < b, comparing major.minor.patch
// numerically. Missing or non-numeric parts count as 0, so "dev" sorts below
// any release.
func versionLess(a, b string) bool {
	pa, pb := parseVer(a), parseVer(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] < pb[i]
		}
	}
	return false
}

func parseVer(v string) [3]int {
	var out [3]int
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	for i, part := range strings.SplitN(v, ".", 3) {
		out[i], _ = strconv.Atoi(strings.TrimSpace(part))
	}
	return out
}

// managedInstall reports whether Zoetrope is running from a system path (the
// dpkg-installed /usr/bin/zoetrope), where updates come as a .deb rather than a
// raw binary.
func managedInstall() bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return strings.HasPrefix(exe, "/usr/")
}
