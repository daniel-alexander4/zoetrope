package main

import (
	"os"
	"os/exec"
	"runtime"
)

// openBrowser opens zoetrope's UI in a chromeless app-mode window.
//
// We prefer a Chromium-family browser's --app mode, which gives a dedicated,
// address-bar-free window that looks like a native desktop app while reusing an
// engine that's already installed. If none is found we fall back to opening the
// URL as an ordinary tab in the default browser. (Safari has no app mode, so a
// Safari-only Mac takes the tab fallback — by design.)
//
// Lifecycle needs no wait on the launched process: the frontend heartbeats the
// server, so closing the window stops the pings and the watchdog shuts us down.
func openBrowser(url string) error {
	if path, ok := findChromium(); ok {
		appArgs := []string{"--app=" + url, "--new-window"}
		if runtime.GOOS == "linux" {
			// Set a stable WM_CLASS so the panel can match this window to
			// zoetrope.desktop (StartupWMClass=Zoetrope) and show the themed
			// icon instead of upscaling the small favicon Chromium derives
			// from the page.
			appArgs = append(appArgs, "--class=Zoetrope")
		}
		cmd := exec.Command(path, appArgs...)
		if err := cmd.Start(); err == nil {
			return nil
		}
		// fall through to the tab fallback if the app-mode launch failed
	}

	name, args := tabOpener(url)
	return exec.Command(name, args...).Start()
}

// fileExists reports whether an absolute path is a regular, runnable file.
func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// findChromium returns the first Chromium-family browser found for the OS.
func findChromium() (string, bool) {
	for _, c := range chromiumCandidates() {
		if path, err := exec.LookPath(c); err == nil {
			return path, true
		}
		if fileExists(c) { // absolute paths (macOS .app bundles)
			return c, true
		}
	}
	return "", false
}

// chromiumCandidates lists browser binaries to try, per OS.
func chromiumCandidates() []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		}
	case "windows":
		return []string{
			`C:\Program Files\Google\Chrome\Application\chrome.exe`,
			`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
			`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
			"chrome.exe", "msedge.exe",
		}
	default: // linux and friends
		return []string{
			"google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
			"microsoft-edge", "brave-browser",
		}
	}
}

// tabOpener returns the OS command that opens a URL in the default browser.
func tabOpener(url string) (string, []string) {
	switch runtime.GOOS {
	case "darwin":
		return "open", []string{url}
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler", url}
	default:
		return "xdg-open", []string{url}
	}
}
