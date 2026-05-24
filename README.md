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
  ball size, cycle duration in seconds); add / reorder / delete playlist
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

`duration` (seconds per cycle, global) and `ballSize` (pixels, global)
apply to every item. `repeats` (per item) is how many cycles play before
the playlist advances. The speed multiplier in the transport bar
scales `duration` at runtime without persisting.

## Build

Requires Go 1.25+, `curl`, `zip`. AppImage assembly downloads
`appimagetool` on first run.

```sh
./build/build.sh           # → dist/{linux, windows, macOS}
./build/build.sh 1.2.3     # set version string baked into Info.plist
```

For local dev:

```sh
go run .
```

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
