# Zoetrope

A tiny desktop app that opens a browser window and plays a configurable
playlist of moving-ball patterns: horizontal / vertical / diagonal sweep,
bounce, circle (CW/CCW), infinity ∞ (horizontal and vertical, CW/CCW).
Background color, ball color, global ball size, global speed, edge-linger
duration (a vision-training pulse at the extreme of each linear sweep),
per-item repeat count, and direction are all editable in the UI and
persist to a JSON file in the OS user config directory.

## Run

Double-click the appropriate artifact for your OS:

| OS      | File                          | First-launch notes                                              |
| ------- | ----------------------------- | --------------------------------------------------------------- |
| Linux   | `Zoetrope-VERSION-linux-amd64.deb` | `sudo apt install ./Zoetrope-*.deb`, then launch from the apps menu. |
| Windows | `Zoetrope.exe`                | SmartScreen will warn (unsigned). Click *More info → Run anyway*.|
| macOS   | `Zoetrope.app`                | Right-click → **Open** the first time (unsigned).               |

On launch, the app:

1. Picks a free port on `127.0.0.1`.
2. Reads or creates `config.json` in the OS user config directory
   (`~/.config/zoetrope`, `%APPDATA%\zoetrope`,
   `~/Library/Application Support/zoetrope`).
3. Opens the UI in a dedicated, chromeless app-mode window using an
   installed Chromium-family browser (Chrome / Edge / Brave / Chromium).
   If none is found it falls back to a normal tab in your default browser.

Quit the app by closing its window — the server notices the window is gone
and shuts itself down shortly after.

## UI

- **Transport bar (bottom)**
  - `|<` Start of playlist
  - `<` Start of current pattern
  - Play / Pause
  - `>` Next pattern
  - Speed multiplier (`0.25×` – `4×`)
  - Gear icon — toggle the editor panel
- **Editor panel (right)** — global controls at top (background color,
  ball size, speed on a 0–10 scale — higher is faster; the dial sets the
  ball's on-screen speed, so every pattern moves at the same pace at a
  given setting); below them, a **Library** picker that selects the
  active playlist + buttons to create / rename / duplicate / delete
  playlists; then add / reorder / delete pattern items in the active
  playlist; per-item color / repeats / direction / angle. Click
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
| serpentine  | raster-scan back-and-forth + interleaved return | yes        | — (see `cornerRadius`, `startCorner`, `lanes`) |
| lightbulbs  | serpentine raster where each turn loops around a bulb | — | — (see `lanes`, `bulbSize`) |
| fig8-h      | figure 8 from two tangent circles (∞ orientation) | yes | —          |
| fig8-v      | figure 8 from two tangent circles (8 orientation) | yes | —          |
| infinity-h  | trace of ∞ (lobes side by side, Lissajous) | yes          | —          |
| infinity-v  | trace of vertical 8 (lobes stacked, Lissajous) | yes      | —          |
| bounce      | `max(w, h)` pixels of travel   | —                      | yes (initial heading) |
| position-sequence | ordered walk through named gaze targets (8-point grid + center) | — | —          |

`speed` (0–10 scale, global; higher = faster) sets the ball's on-screen
pixel speed — each pattern's cycle is normalized by its path length so
they all move at the same pace at a given setting (calibrated to the
circle; exact on a 16:9 viewport). `ballSize` (pixels, global) applies to
every item. `repeats` (per item) is how many cycles play before the
playlist advances. A per-item `speed` (0–10) overrides the global dial for
that one item; leave it blank to follow the global speed. The speed
multiplier in the transport bar scales the effective speed at runtime
without persisting.

The `serpentine` pattern is a closed-loop raster scan. The ball sweeps
across `lanes` horizontal lanes (2–8, default 3), dropping into the next
lane at each end via a U-turn, until it reaches the bottom ("Turn") —
then serpentines back up through the gaps between the down-lanes,
returning to Start to close the loop. Per-item fields: `cornerRadius`
(0–1, how round the U-turns are; 0 = sharp, 1 = full half-circle),
`startCorner` (`tl` or `tr`), `lanes` (integer), and `direction`
(`cw` runs the loop forward, `ccw` reverses it).

The `lightbulbs` pattern shares the serpentine's interleaved closed-loop
raster, but every turn balloons into a near-full circular loop — a "bulb"
the ball traces before continuing down the thin lane. Per-item fields:
`lanes` (2–8, default 3) and `bulbSize` (0–1, how large the bulbs are).

`lingerSec` (global, default 0) is a vision-training aid for the linear
patterns (h-sweep, v-sweep, diag-ulbr, diag-urbl). When > 0, the ball
stops at each extreme of a sweep, grows to 2× then shrinks back over
`lingerSec` seconds before reversing direction — peripheral feedback so
the viewer can keep their eyes moving "off-screen" and pick the ball
back up smoothly when it returns. Cycle time extends by 2 × `lingerSec`
so the on-screen motion pace stays consistent regardless of dwell.

### Position-sequence patterns (IEMT / saccade / brainspotting / etc.)

`position-sequence` is a separate engine from the continuous patterns
above. Each item has an ordered list of `steps`, each referencing one of
nine named gaze targets on a 3×3 grid:

```
up-l       up        up-r
lateral-l  center    lateral-r
down-l     down      down-r
```

Per-item `dwellSec` (default 1.5s) is the time the ball holds at each
position. `transitSec` (default 0.8s) is the smooth-pursuit time between
positions (cosine ease-in-out). The global `speed` knob scales the whole
sequence: `speed = 2` honors the configured dwell/transit; higher = faster.
Toggle **Show position labels** in the editor to overlay grid labels —
useful while learning the positions, off for live sessions. The optional
per-item `name` field overrides the pattern's default label in the editor
and the now-playing strip.

Two IEMT-category playlists ship in the default config: "IEMT · Identity
(draft)" (16 steps with returns to center between each cardinal/diagonal)
and "IEMT · Emotion (draft)" (continuous 8-position round). Both are
starting drafts — the exact step orderings are placeholders rather than
canonical clinical sequences.

## Playlists

The editor library holds any number of named playlists, each filed under
a free-form **Category** (e.g. `Continuous`, `IEMT`, `EMDR`). The Library
picker switches which one plays — the engine resets to the first item of
the chosen playlist. The default config ships:

- `Default` (Continuous) — the eight continuous sweep / circle / infinity /
  bounce patterns, active on first launch.
- `IEMT · Identity (draft)` (IEMT)
- `IEMT · Emotion (draft)` (IEMT)

New playlists default to the currently-active playlist's category;
**+ New category…** in the Category dropdown lets you start a fresh
grouping (e.g. add an EMDR set). Renames are name-collision-safe — a
duplicate name gets ` (2)`, ` (3)` appended automatically.

Each playlist has a **Loop** toggle (next to the picker). With Loop on
(the default) the playlist cycles back to the first item after the last;
with it off the playlist rewinds to its first item and stops there when it
reaches the end — re-engage play to run it again. The toggle applies to
built-in playlists too.

## Safety and framing

Zoetrope is a configurable gaze-target animation tool — a piece of
software that moves a ball on a screen. It is **not** a treatment or a
substitute for clinical care. The included IEMT presets and any other
named modality (saccade training, anti-saccade, brainspotting fixation,
EMDR, etc.) are starting templates for use **with a qualified
practitioner** of that modality. Nothing in this README or the in-app
copy is a therapeutic claim.

## Build & versioning

Requires Go 1.25+, `zip`, and (for the Debian package) `dpkg-deb`.

The version string lives in the top-level `VERSION` file (e.g. `0.1.0`,
no leading `v`). It's `//go:embed`-ed into the binary (`main.go`), so the
running app reports it at startup and on `GET /version`. `build/build.sh`
reads the same file to name the artifacts and stamp the macOS `Info.plist`
and the `.deb` control file — one source, no overrides.

```sh
go run .          # reports the VERSION file's value
./build/build.sh  # builds every artifact from the same file
```

To cut a release: bump `VERSION`, commit, tag `vX.Y.Z`, rebuild.

## Layout

```
.
├── main.go         entry point, listener, idle-shutdown, signal handling
├── config.go       JSON load/save, defaults, atomic writes
├── server.go       HTTP routes, embedded asset serving
├── browser.go      app-mode window launch, with default-browser tab fallback
├── web/            embedded UI (HTML/CSS/JS)
│   ├── app.js      rAF animation loop, transport, editor wiring
│   ├── patterns.js SoT for the animation kinematics
│   └── editor.js   config editor sidebar (playlists, items, globals)
└── build/          cross-compile script, Info.plist, .desktop entry, lipo helper
```
