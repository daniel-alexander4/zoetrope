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
  cycle per second); below them, a **Library** picker that selects the
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
| infinity-h  | trace of ∞ (lobes side by side) | yes                   | —          |
| infinity-v  | trace of vertical 8 (lobes stacked) | yes               | —          |
| bounce      | `max(w, h)` pixels of travel   | —                      | yes (initial heading) |
| position-sequence | ordered walk through named gaze targets (8-point grid + center) | — | —          |

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

In manager mode, switching the active playlist (or editing any other
config field) pushes the fresh config to every connected client mid-
session; the client returns to its own library when the session ends.

## Safety and framing

Zoetrope is a configurable gaze-target animation tool — a piece of
software that moves a ball on a screen. It is **not** a treatment or a
substitute for clinical care. The included IEMT presets and any other
named modality (saccade training, anti-saccade, brainspotting fixation,
EMDR, etc.) are starting templates for use **with a qualified
practitioner** of that modality. Nothing in this README or the in-app
copy is a therapeutic claim.

## Networking — manager / client / standalone

Zoetrope has three runtime modes. Every launch starts in **standalone**
(the existing behavior, full local control). A practitioner can host a
session for a remote client; the client pastes the resulting URL into
their own Zoetrope and the practitioner drives the animation in real
time.

For use with a qualified IEMT / EMDR / ART practitioner. Zoetrope is a
tool, not a treatment.

### Modes

- **Standalone** — the default. Full local UI; nothing on the network.
- **Manager** — replaces the animation viewport with a control surface.
  The binary listens on a public port and accepts connections from
  clients who paste the session URL.
- **Client** — the animation viewport is unchanged but the transport
  controls collapse to a single "Leave session" button plus a connection
  pill. The practitioner drives every transport action.

Mode is per-binary (not per-tab) and is **not persisted** across
restart — every launch starts standalone.

### How a session works

The practitioner runs Zoetrope on a machine with a public IP (or a
forwarded port at their router) and clicks **Generate connection string**
in the editor's Network block. The binary:

1. Asks `api64.ipify.org` for the practitioner's public IP (one outbound
   call, user-initiated by the button click).
2. Enters manager mode and binds the hardcoded port **38130**.
3. Mints a fresh per-session client cert.
4. Returns a session URL of the form
   `zoetrope://join?ws=wss://<public-ip>:38130#<base64url payload>`.

Each click of **+ Generate connection string** in the manager view mints
another URL for another client. The practitioner shares each URL with
its intended client via text/email. Sessions are single-pair, expire
after 10 minutes if unjoined, and survive a 60-second drop before being
torn down.

The client opens Zoetrope, clicks **Join a session**, and pastes the
URL. Zoetrope dials the manager over mTLS (TLS 1.3, both sides pinning
each other's self-signed cert by SHA-256 fingerprint); no CA, no
domain name, no plaintext. If the URL is malformed, expired, or the
manager's cert doesn't match the pin, the client refuses to connect.

### Practitioner identity

On first entry into manager mode, Zoetrope generates a long-lived
Ed25519 keypair + self-signed cert and stores it at:

- Linux: `~/.config/zoetrope/practitioner_identity.pem`
- macOS: `~/Library/Application Support/zoetrope/practitioner_identity.pem`
- Windows: `%APPDATA%\zoetrope\practitioner_identity.pem`

Mode `0600`. Every session URL the practitioner mints carries this
cert's fingerprint, which the client pins. Clients can confirm "same
practitioner as last time" by comparing fingerprints across URLs.

Rotation is manual: delete the file and re-enter manager mode. **Doing
so invalidates every session URL the practitioner has ever shared.**

### Firewalls and ports

The listen port is hardcoded to **38130**. Two firewall layers to set up:

1. **Router NAT** — forward TCP `38130` from your public IP to the host
   running Zoetrope. The client does no firewall work.
2. **Local OS firewall** — Windows Defender Firewall / macOS firewall /
   `ufw` will block inbound on `38130` by default. Allow inbound TCP on
   `38130` for `zoetrope`.

If the listener starts but no client ever reaches it, check both.

### Protocol

JSON frames over a WebSocket inside the TLS connection. Manager → client:
`play`, `pause`, `resume`, `advance`, `back`, `hold`, `release`,
`advance-position`, `back-position`, `stop`, `set-sequence`,
`set-config`. Client → manager: `hello`, `sequences`, `state`.
Bidirectional: `file-offer`, `file-accept`, `file-chunk`, `file-cancel`
(see File sharing below); `audio-offer`, `audio-answer`, `audio-ice`,
`audio-bye` (see Voice call). Every frame carries `pv: 1` so future
revisions can negotiate cleanly.

`advance-position` / `back-position` step a position-sequence pattern by
one position (with wrap); `hold` pauses with a snap to the current
position. They no-op on continuous patterns.

### Client records

The practitioner can keep persistent records of their clients — a name,
free-form notes, and a session log per client. From `/manage` in MI view,
the **Clients** card lists existing clients and lets the practitioner add
new ones. Opening a client surfaces a notes textarea (autosaved) and a
timeline of past sessions with date / time / duration.

"🔗 Generate URL" from the client detail view mints a connection string
*bound to that client*. When the client connects, a session-log entry is
opened automatically; when they disconnect, it's finalized with the
duration. Connection strings minted from Landing (the standalone "+"
button) are unattached and don't log.

Records live under `<user-config>/zoetrope/clients/<slug>/`:

```
clients/
  alice-7f3a2/
    client.json    {id, name, createdAt}
    notes.md       rolling notes; practitioner-owned, no auto-edits
    sessions/
      2026-05-25T19-32-00/
        meta.json  {id, startedAt, endedAt, durationSec, sessionCertFP}
```

Directories are mode `0700`, files `0600`. **No encryption at rest in v1**
— relies on the host OS's user-level file permissions. The practitioner
is responsible for retention, consent, and compliance with their
jurisdiction; nothing about this feature is synced or transmitted
off-device.

### Voice call

Either side can place a voice call across an active session. The 📞
button on each session card (manager) and in the client overlay
(client) starts the call; the other side sees an Accept / Decline
prompt. Once accepted, audio flows direct browser↔browser over
DTLS-SRTP (UDP) — the Go process relays only the SDP / ICE signaling
verbs (`audio-offer` / `audio-answer` / `audio-ice` / `audio-bye`) over
the existing mTLS WebSocket.

The MI Audio card shows the active call's state pill, mic-mute, speaker
volume slider, and an End-call button. Mic mute is local-only — the
muted user can still hear the peer. Speaker volume + mute are local.
Hanging up sends `audio-bye` and tears the peer connection down on
both sides.

No STUN or TURN servers are contacted — keeping the "no telemetry, no
phone-home" rule intact. The manager's address is already public (it's
in the session URL), so ICE works in friendly NAT environments via
host + peer-reflexive candidates. Restrictive symmetric NATs may need
additional firewall work; this is a known limit.

Headphones are recommended on both sides. Browsers do echo cancellation
on the microphone path, but a speaker that's audible to the mic can
still cause feedback that AEC won't fully suppress.

### File sharing

Either side can send a file across an active session. Three ways to
start a send:

- **📎** on each session card (manager) or in the client-mode overlay
  (client) opens a native file picker.
- **Drag-and-drop** a file onto a session card, the MI **Files** card,
  or the client-side overlay — the host highlights while you drag and
  the send starts on drop.
- **Files card** on `/manage` in MI view: pick a client, choose a file,
  click **Send**. The button is disabled until a file is chosen and the
  selected client has a live session.

The sender sees a progress card with a chunks-done / chunks-total bar
that ticks through the transfer; the receiver's `file-accept` flips it
to "Accepted, sending…" before chunks start landing, and the card
auto-dismisses 3 s after "Sent." On the receiver, an inline
notification shows filename + size and offers **Save** (browser
download), **Open** (new tab), or **Dismiss**.

Storage depends on whether the session is bound to a client:

- **Bound session** — the file is persisted under the client's record
  at `<user-config>/zoetrope/clients/<slug>/inbox/<eid>/{meta.json, blob}`
  and stays there across session removal and binary restarts. The MI
  Files card lists every received file for that client with Open +
  Dismiss; Save / Open from the inline notification fetch the same
  bytes.
- **Unbound session** — the bytes live in memory only and are dropped
  five minutes after arrival if the user hasn't fetched them. Save or
  Open consumes the in-memory entry.

Size is capped per machine via **Max transfer size (MiB)** in the
editor (default 16 MiB). The cap is sticky on the receiver — a
manager-pushed config does not override the client's local value, so
the client controls what they will accept. Set the cap to `0` to
disable file transfer on this machine.

Any file type is accepted: no extension allowlist, no MIME sniffing.
The browser handles received bytes through Blob URLs, so executables
arrive as inert downloads — they are not run.

### Limitations to be aware of

- A manager-binary crash invalidates active sessions; clients see a
  connection error and must re-paste a fresh URL.
- Per-device practitioner identity — switching machines makes the
  practitioner look new to clients. Move `practitioner_identity.pem`
  manually if you want continuity.
- The animation viewport renders whatever the **client's** local config
  declares (background, ball size, palette). The manager drives playback,
  not appearance.

## Build & versioning

Requires Go 1.25+, `zip`, and (for the Debian package) `dpkg-deb`.

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
├── crypto.go       practitioner + per-session identities
├── link.go         WS transport, mTLS pinning, frame I/O
├── mode.go         standalone / manager / client transitions + sessions
├── transfer.go     file-transfer protocol (chunking, inbox, caps)
├── clients.go      client + session records (on-disk schema, atomic writes)
├── bridge.go       SSE bus between Go and browser tabs
├── web/            embedded UI (HTML/CSS/JS)
│   └── audio.js    SoT for the in-browser WebRTC voice-call state machine
└── build/          cross-compile script, Info.plist, .desktop entry, lipo helper
```
