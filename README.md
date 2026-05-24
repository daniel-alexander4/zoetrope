# Zoetrope

A tiny desktop app that opens a browser window and plays a configurable
playlist of moving-ball patterns: horizontal/vertical sweep, bounce,
circle (CW/CCW), figure-8 (CW/CCW). Background color, ball color, ball
size, per-pattern duration, repeat count, direction, and a global speed
multiplier are all editable in the UI and persist to a JSON file in the
OS user config directory.

## Run

Double-click the appropriate artifact for your OS:

| OS      | File                          | First-launch notes                                              |
| ------- | ----------------------------- | --------------------------------------------------------------- |
| Linux   | `Zoetrope-x86_64.AppImage`    | `chmod +x` it once, then double-click.                          |
| Windows | `Zoetrope.exe`                | SmartScreen will warn (unsigned). Click *More info → Run anyway*.|
| macOS   | `Zoetrope.app`                | Right-click → **Open** the first time (unsigned).               |

On launch, the app:

1. Picks a free port on `127.0.0.1`.
2. Reads or creates `config.json` in the OS user config directory
   (`~/.config/zoetrope`, `%APPDATA%\zoetrope`,
   `~/Library/Application Support/zoetrope`).
3. Opens your default browser to the local URL.

Quit the app from its terminal/launch icon, or close it from your OS task
manager. The browser tab is harmless on its own.

## UI

- **Transport bar (bottom)**
  - `|<` Start of playlist
  - `<` Start of current pattern
  - Play / Pause
  - Stop (pause + reset to playlist start)
  - `>` Next pattern
  - Speed multiplier (`0.25×` – `4×`)
  - Gear icon — toggle the editor panel
- **Editor panel (right)** — global controls at top (background color,
  ball size, speed on a 0–10 scale — higher is faster, 10 ≈ one
  cycle per second); add / reorder / delete playlist
  items below; per-item color / repeats / direction / angle. Click
  **Save** to write to the config file; **Revert** discards unsaved
  edits.
- **Keyboard shortcuts** — Space (play/pause), ← (start of pattern),
  → (next pattern), Home (start of playlist).

## Patterns

| Pattern     | Cycle = one full…              | Direction (`cw`/`ccw`) | `angleDeg` |
| ----------- | ------------------------------ | ---------------------- | ---------- |
| h-sweep     | left → right → left            | —                      | —          |
| v-sweep     | top → bottom → top             | —                      | —          |
| diag-ulbr   | upper-left ↔ bottom-right (↘)  | —                      | —          |
| diag-urbl   | upper-right ↔ bottom-left (↙)  | —                      | —          |
| circle      | revolution                     | yes                    | —          |
| infinity-h  | trace of ∞ (lobes side by side) | yes                   | —          |
| infinity-v  | trace of vertical 8 (lobes stacked) | yes               | —          |
| bounce      | `max(w, h)` pixels of travel   | —                      | yes (initial heading) |

`speed` (0–10 scale, global; higher = faster, 10 means one cycle per
second) and `ballSize` (pixels, global) apply to every item. `repeats`
(per item) is how many cycles play before the playlist advances. The
speed multiplier in the transport bar scales `speed` at runtime without
persisting.

`lingerSec` (global, default 0) is a vision-training aid for the linear
patterns (h-sweep, v-sweep, diag-ulbr, diag-urbl). When > 0, the ball
stops at each extreme of a sweep, grows to 2× then shrinks back over
`lingerSec` seconds before reversing direction — peripheral feedback so
the viewer can keep their eyes moving "off-screen" and pick the ball
back up smoothly when it returns. Cycle time extends by 2 × `lingerSec`
so the on-screen motion pace stays consistent regardless of dwell.

## Build & versioning

Requires Go 1.25+, `curl`, `zip`. AppImage assembly downloads
`appimagetool` on first run.

The version string lives in the top-level `VERSION` file (e.g. `0.1.0`,
no leading `v`). `build/build.sh` reads it and bakes it into every
artifact via `-ldflags "-X main.version=…"`; the macOS `Info.plist`
gets the same value. Override per-build with an arg or env var:

```sh
./build/build.sh           # reads VERSION
./build/build.sh 1.2.3     # overrides
VERSION=1.2.3 ./build/build.sh
```

For local dev, the in-source default is `0.0.0-dev` so it's easy to
tell a `go run .` / `go build` binary from a release.

```sh
go run .
```

To cut a release: bump `VERSION`, commit, tag `vX.Y.Z`, rebuild.

## Layout

```
.
├── main.go         entry point, listener, signal handling
├── config.go       JSON load/save, defaults, atomic writes
├── server.go       HTTP routes, embedded asset serving
├── browser.go      cross-platform default-browser open
├── web/            embedded UI (HTML/CSS/JS)
└── build/          cross-compile script, icon, Info.plist, AppImage glue
```
