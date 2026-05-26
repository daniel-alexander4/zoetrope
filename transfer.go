// transfer.go: file-transfer protocol — chunk-stream over the same JSON
// frames the rest of mode.go uses, plus an in-memory inbox that the browser
// fetches via /api/inbox/{id}.
//
// Single source of truth for the verb shapes (file-offer / file-chunk /
// file-cancel), chunk reassembly, size enforcement, and the receiver-side
// state lifecycle. Other code calls in; it does not re-implement.
//
// Bytes never touch disk on either end. Senders stream chunks straight
// from memory; receivers reassemble in memory and surface a notification,
// leaving the user to save or open through the browser.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/coder/websocket"
)

const (
	// Each chunk carries this many raw bytes max; with base64 (33% inflation)
	// plus a small JSON envelope this stays comfortably under the
	// linkMaxMessageBytes (256 KiB) wire cap.
	transferRawChunk = 128 * 1024

	// An in-progress receive that hasn't seen a new chunk in this long is
	// treated as abandoned and dropped on the next sweep.
	transferIdleTimeout = 60 * time.Second

	// A completed transfer that the browser hasn't fetched in this long is
	// dropped to keep memory bounded.
	inboxTTL = 5 * time.Minute

	// Maximum concurrent in-progress receives per modeState. Beyond this the
	// receiver rejects new offers with file-cancel.
	transferMaxConcurrent = 8

	// Per-chunk write deadline — generous so a slow LAN doesn't trip ping.
	transferChunkWriteTimeout = 30 * time.Second
)

// transferTX is the sender-side handle needed to abort an in-flight
// outbound transfer mid-stream. Held in m.outProgress while a
// writeTransfer goroutine is running; CancelOutbound looks it up and
// calls cancel() to signal the goroutine to stop and notify the peer.
type transferTX struct {
	name   string
	cancel context.CancelFunc
}

// transferRX is one in-progress inbound transfer.
type transferRX struct {
	id           string
	name         string
	mime         string
	sourceFP     string // empty when received from the manager (client mode)
	sizeBytes    int64
	chunks       int
	received     [][]byte // indexed by chunk idx; nil = not yet received
	receivedSz   int64
	lastActivity time.Time
}

// inboxEntry is a completed transfer. For unbound (in-memory) entries
// `data` holds the bytes until the browser fetches and consumeInbox
// drops the entry. For bound entries (persisted under the client's
// dir), `data` is nil — the blob lives on disk and is fetched via
// /api/clients/<cid>/inbox/<id>. `sizeBytes` is set in both cases so
// the SSE event can report size without inspecting data.
type inboxEntry struct {
	id        string
	name      string
	mime      string
	sourceFP  string
	sizeBytes int64
	data      []byte
	addedAt   time.Time
}

// On-wire shapes.
type fileOfferFrame struct {
	TransferID string `json:"transfer_id"`
	Name       string `json:"name"`
	SizeBytes  int64  `json:"size_bytes"`
	MIME       string `json:"mime,omitempty"`
	Chunks     int    `json:"chunks"`
}

type fileChunkFrame struct {
	TransferID string `json:"transfer_id"`
	Idx        int    `json:"idx"`
	Data       string `json:"data"` // base64.RawStdEncoding
}

type fileCancelFrame struct {
	TransferID string `json:"transfer_id"`
	Reason     string `json:"reason,omitempty"`
}

// fileAcceptFrame is the receiver-to-sender ack after a successful
// startInbound. Sender uses it to flip the progress card from
// "Sending…" to "Accepted, sending…" — purely informational; the
// sender keeps writing chunks regardless.
type fileAcceptFrame struct {
	TransferID string `json:"transfer_id"`
}

// transferProgressEvent is published on the SENDER side after each
// chunk write so the local browser can render a progress bar. Bus is
// per-process so this only reaches the sending machine's UI.
type transferProgressEvent struct {
	TransferID  string `json:"transfer_id"`
	Name        string `json:"name,omitempty"`
	ChunksDone  int    `json:"chunks_done"`
	ChunksTotal int    `json:"chunks_total"`
	SizeBytes   int64  `json:"size_bytes"`
}

// transferLifecycleEvent is the shape for accepted / completed /
// failed events on the sender side. `reason` is populated on failed.
type transferLifecycleEvent struct {
	TransferID string `json:"transfer_id"`
	Name       string `json:"name,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

// fileReceivedEvent is the SSE payload published when a transfer completes.
// `direction` is "from-session" when the manager received from a session,
// "from-manager" when the client received from the manager. Browsers route
// off this to decide whether they're the audience. `entry_url` is the
// fetch URL for the bytes — points at /api/inbox/<id> for in-memory
// entries (5-min TTL, consumed on fetch) and at
// /api/clients/<cid>/inbox/<id> for client-bound persistent entries.
// `client_id` is non-empty for bound entries; the MI Files card uses it
// to refresh the relevant client's inbox list.
type fileReceivedEvent struct {
	TransferID string `json:"transfer_id"`
	Name       string `json:"name"`
	SizeBytes  int64  `json:"size_bytes"`
	MIME       string `json:"mime,omitempty"`
	SourceFP   string `json:"source_fp,omitempty"`
	Direction  string `json:"direction"`
	ClientID   string `json:"client_id,omitempty"`
	EntryURL   string `json:"entry_url"`
}

// newTransferID returns a short random hex string used as a transfer ID.
// 12 bytes (96 bits) is overkill for collision avoidance across the handful
// of concurrent transfers a session ever sees, but the cost is nil.
func newTransferID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand never fails on a healthy system; fall back to time
		// to keep things moving rather than refusing the transfer.
		return fmt.Sprintf("t-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// startInbound creates a transferRX state from an offer, enforcing the
// receiver's size cap and concurrency limit. Returns a non-empty reason
// when the offer is rejected — caller relays it via file-cancel.
func (m *modeState) startInbound(offer fileOfferFrame, sourceFP string, cap int64) (*transferRX, string) {
	if offer.TransferID == "" {
		return nil, "missing transfer_id"
	}
	if offer.SizeBytes < 0 || offer.Chunks <= 0 {
		return nil, "invalid offer"
	}
	if cap > 0 && offer.SizeBytes > cap {
		return nil, "size"
	}
	rx := &transferRX{
		id:           offer.TransferID,
		name:         offer.Name,
		mime:         offer.MIME,
		sourceFP:     sourceFP,
		sizeBytes:    offer.SizeBytes,
		chunks:       offer.Chunks,
		received:     make([][]byte, offer.Chunks),
		lastActivity: time.Now(),
	}
	m.transferMu.Lock()
	defer m.transferMu.Unlock()
	if _, dup := m.inProgress[offer.TransferID]; dup {
		return nil, "duplicate"
	}
	if len(m.inProgress) >= transferMaxConcurrent {
		return nil, "too many concurrent transfers"
	}
	m.inProgress[offer.TransferID] = rx
	return rx, ""
}

// addChunk stores one received chunk. done=true means every chunk is in;
// caller then finalizes. err means caller should cancel.
func (m *modeState) addChunk(chunk fileChunkFrame) (rx *transferRX, done bool, err error) {
	m.transferMu.Lock()
	defer m.transferMu.Unlock()
	rx = m.inProgress[chunk.TransferID]
	if rx == nil {
		return nil, false, errors.New("unknown transfer_id")
	}
	if chunk.Idx < 0 || chunk.Idx >= rx.chunks {
		return rx, false, fmt.Errorf("chunk index %d out of range [0,%d)", chunk.Idx, rx.chunks)
	}
	if rx.received[chunk.Idx] != nil {
		return rx, false, fmt.Errorf("chunk %d already received", chunk.Idx)
	}
	raw, derr := base64.RawStdEncoding.DecodeString(chunk.Data)
	if derr != nil {
		raw, derr = base64.StdEncoding.DecodeString(chunk.Data)
		if derr != nil {
			return rx, false, fmt.Errorf("decode chunk: %w", derr)
		}
	}
	rx.received[chunk.Idx] = raw
	rx.receivedSz += int64(len(raw))
	if rx.receivedSz > rx.sizeBytes {
		return rx, false, fmt.Errorf("payload exceeds declared size (%d > %d)", rx.receivedSz, rx.sizeBytes)
	}
	rx.lastActivity = time.Now()
	for _, c := range rx.received {
		if c == nil {
			return rx, false, nil
		}
	}
	if rx.receivedSz != rx.sizeBytes {
		return rx, false, fmt.Errorf("payload size mismatch (%d != %d)", rx.receivedSz, rx.sizeBytes)
	}
	return rx, true, nil
}

// finalizeInbound moves a fully-received transfer out of in-progress.
// When clientID is non-empty, the bytes are persisted under that
// client's dir and the returned entry references the on-disk record
// (data is nil; fetch via /api/clients/<cid>/inbox/<id>). When clientID
// is empty, the entry holds bytes in the in-memory inbox (5-min TTL,
// consumed on first fetch via /api/inbox/<id>). Returns an error only
// when persistence fails — the caller relays it as a file-cancel.
func (m *modeState) finalizeInbound(rx *transferRX, clientID string) (*inboxEntry, error) {
	out := make([]byte, 0, rx.receivedSz)
	for _, c := range rx.received {
		out = append(out, c...)
	}
	m.transferMu.Lock()
	delete(m.inProgress, rx.id)
	m.transferMu.Unlock()

	if clientID != "" && m.clients != nil {
		rec, err := m.clients.InboxAdd(clientID, rx.name, rx.mime, out, rx.sourceFP)
		if err != nil {
			return nil, err
		}
		return &inboxEntry{
			id:        rec.ID,
			name:      rec.Name,
			mime:      rec.MIME,
			sourceFP:  rec.SourceFP,
			sizeBytes: rec.SizeBytes,
			addedAt:   rec.ReceivedAt,
		}, nil
	}

	entry := &inboxEntry{
		id:        rx.id,
		name:      rx.name,
		mime:      rx.mime,
		sourceFP:  rx.sourceFP,
		sizeBytes: rx.receivedSz,
		data:      out,
		addedAt:   time.Now(),
	}
	m.transferMu.Lock()
	m.inbox[rx.id] = entry
	m.transferMu.Unlock()
	return entry, nil
}

// abortInbound drops an in-progress transfer (peer canceled or receive
// error). Safe to call with an unknown ID.
func (m *modeState) abortInbound(id string) {
	m.transferMu.Lock()
	delete(m.inProgress, id)
	m.transferMu.Unlock()
}

// registerOutbound records an in-flight outbound transfer so
// CancelOutbound can find it. Paired with unregisterOutbound on every
// exit path of writeTransfer / writeTransferLoopback.
func (m *modeState) registerOutbound(id, name string, cancel context.CancelFunc) {
	m.transferMu.Lock()
	m.outProgress[id] = &transferTX{name: name, cancel: cancel}
	m.transferMu.Unlock()
}

func (m *modeState) unregisterOutbound(id string) {
	m.transferMu.Lock()
	delete(m.outProgress, id)
	m.transferMu.Unlock()
}

// CancelOutbound signals the in-flight writeTransfer goroutine for id
// to abort. The goroutine handles its own cleanup — notifies the peer
// with a file-cancel frame, publishes transfer-failed, and unregisters
// itself. Returns "not found" if the transfer already completed or
// never existed.
func (m *modeState) CancelOutbound(id string) error {
	m.transferMu.Lock()
	tx, ok := m.outProgress[id]
	m.transferMu.Unlock()
	if !ok {
		return fmt.Errorf("transfer %s not found", id)
	}
	tx.cancel()
	return nil
}

// consumeInbox returns and deletes a completed transfer. Used by the
// /api/inbox/{id} handler — Save/Open in the browser is a one-shot fetch.
func (m *modeState) consumeInbox(id string) (*inboxEntry, bool) {
	m.transferMu.Lock()
	defer m.transferMu.Unlock()
	e, ok := m.inbox[id]
	if !ok {
		return nil, false
	}
	delete(m.inbox, id)
	return e, true
}

// dismissInbox deletes a completed transfer without serving it. Used when
// the user clicks Dismiss in the notification UI.
func (m *modeState) dismissInbox(id string) bool {
	m.transferMu.Lock()
	defer m.transferMu.Unlock()
	if _, ok := m.inbox[id]; !ok {
		return false
	}
	delete(m.inbox, id)
	return true
}

// dropTransfersForSession drops any in-progress receives and inbox entries
// whose source is the given fp. Called from RemoveSession so a removed
// session doesn't leave orphaned bytes behind.
func (m *modeState) dropTransfersForSession(fp string) {
	m.transferMu.Lock()
	defer m.transferMu.Unlock()
	for id, rx := range m.inProgress {
		if rx.sourceFP == fp {
			delete(m.inProgress, id)
		}
	}
	for id, e := range m.inbox {
		if e.sourceFP == fp {
			delete(m.inbox, id)
		}
	}
}

// resetTransfers drops every in-progress and completed transfer. Called on
// transitions back to standalone, where nothing in flight is meaningful.
func (m *modeState) resetTransfers() {
	m.transferMu.Lock()
	defer m.transferMu.Unlock()
	m.inProgress = make(map[string]*transferRX)
	m.inbox = make(map[string]*inboxEntry)
}

// sweepTransfers drops stale in-progress receives and TTL-expired inbox
// entries. Called from the main watchdog tick.
func (m *modeState) sweepTransfers() {
	now := time.Now()
	m.transferMu.Lock()
	defer m.transferMu.Unlock()
	for id, rx := range m.inProgress {
		if now.Sub(rx.lastActivity) > transferIdleTimeout {
			delete(m.inProgress, id)
		}
	}
	for id, e := range m.inbox {
		if now.Sub(e.addedAt) > inboxTTL {
			delete(m.inbox, id)
		}
	}
}

// ---- Outbound: chunk-and-send -------------------------------------------

// SendFileToSession is the manager-side outbound path: write a file-offer
// followed by file-chunk frames to the given session's WS. id is the
// pre-generated transfer ID (the HTTP handler hands it to the caller
// synchronously before spawning the actual write in a goroutine, so the
// browser can subscribe to lifecycle events on this id immediately).
// Validation failures are surfaced as transfer-failed bus events so the
// async caller doesn't have to plumb the error back through SSE itself.
func (m *modeState) SendFileToSession(fp, id, name, mime string, data []byte) error {
	if cap := m.store.Get().MaxTransferBytes; cap > 0 && int64(len(data)) > cap {
		err := fmt.Errorf("file size %d exceeds local cap %d", len(data), cap)
		m.bus.Publish("transfer-failed", transferLifecycleEvent{TransferID: id, Name: name, Reason: err.Error()})
		return err
	}
	sess := m.lookupSession(fp)
	if sess == nil {
		err := fmt.Errorf("no session %s", fp)
		m.bus.Publish("transfer-failed", transferLifecycleEvent{TransferID: id, Name: name, Reason: err.Error()})
		return err
	}
	sess.mu.Lock()
	conn := sess.wsConn
	sess.mu.Unlock()
	if conn == nil {
		err := errors.New("session not connected")
		m.bus.Publish("transfer-failed", transferLifecycleEvent{TransferID: id, Name: name, Reason: err.Error()})
		return err
	}
	return m.writeTransfer(conn, sess, id, name, mime, data)
}

// SendFileToManager is the client-side outbound path: write file-offer +
// chunks to the manager WS. id semantics match SendFileToSession. In
// loopback mode the manager-bound send is short-circuited through the
// receive path the same way SendFileToSession's loopback path is.
func (m *modeState) SendFileToManager(id, name, mime string, data []byte) error {
	if cap := m.store.Get().MaxTransferBytes; cap > 0 && int64(len(data)) > cap {
		err := fmt.Errorf("file size %d exceeds local cap %d", len(data), cap)
		m.bus.Publish("transfer-failed", transferLifecycleEvent{TransferID: id, Name: name, Reason: err.Error()})
		return err
	}
	m.mu.Lock()
	conn := m.clientConn
	mode := m.current
	loopSess := m.sessions[loopbackSessionFP]
	m.mu.Unlock()
	if loopSess != nil {
		// Loopback path: the "client" tab's send lands in the manager's
		// inbox via the same receive code the WS path uses.
		return m.writeTransferLoopback(loopSess, id, name, mime, data, "from-session")
	}
	if mode != modeClient {
		err := errors.New("not in client mode")
		m.bus.Publish("transfer-failed", transferLifecycleEvent{TransferID: id, Name: name, Reason: err.Error()})
		return err
	}
	if conn == nil {
		err := errors.New("not connected")
		m.bus.Publish("transfer-failed", transferLifecycleEvent{TransferID: id, Name: name, Reason: err.Error()})
		return err
	}
	return m.writeTransfer(conn, nil, id, name, mime, data)
}

// writeTransferLoopback is the in-process equivalent of writeTransfer
// for the synthetic loopback session: instead of writing frames to a WS,
// each offer / chunk is dispatched straight to handleInboundTransferFrame
// so chunks reassemble + persist exactly as if a remote peer had sent
// them. Publishes the same lifecycle events so both browser tabs see
// the transfer through the existing SSE plumbing.
func (m *modeState) writeTransferLoopback(sess *session, id, name, mime string, data []byte, direction string) error {
	chunks := (len(data) + transferRawChunk - 1) / transferRawChunk
	if chunks == 0 {
		chunks = 1
	}
	sizeBytes := int64(len(data))

	abortCtx, abortFn := context.WithCancel(context.Background())
	m.registerOutbound(id, name, abortFn)
	defer m.unregisterOutbound(id)
	defer abortFn()

	// announceCancelLoopback dispatches file-cancel into the local receive
	// path so the receiver drops its inbound state, then publishes
	// transfer-failed for the sender's UI. Mirrors the WS path's
	// sendCancel + transfer-failed pair.
	announceCancelLoopback := func() {
		cancelFrame := map[string]any{
			"type":        "file-cancel",
			"transfer_id": id,
			"reason":      "canceled by sender",
		}
		if raw, err := json.Marshal(cancelFrame); err == nil {
			m.handleInboundTransferFrame("file-cancel", raw, loopbackSessionFP, sess, nil, direction)
		}
		m.bus.Publish("transfer-failed", transferLifecycleEvent{TransferID: id, Name: name, Reason: "canceled by sender"})
	}

	offerFrame := map[string]any{
		"type":        "file-offer",
		"transfer_id": id,
		"name":        name,
		"size_bytes":  len(data),
		"mime":        mime,
		"chunks":      chunks,
	}
	offerRaw, err := json.Marshal(offerFrame)
	if err != nil {
		m.bus.Publish("transfer-failed", transferLifecycleEvent{TransferID: id, Name: name, Reason: "marshal offer: " + err.Error()})
		return fmt.Errorf("marshal offer: %w", err)
	}
	m.handleInboundTransferFrame("file-offer", offerRaw, loopbackSessionFP, sess, nil, direction)
	// Receiver-side startInbound succeeded; sendAccept is a no-op on
	// loopback so the sender sees the "Accepted" toast via a direct
	// bus publish here.
	m.bus.Publish("transfer-accepted", transferLifecycleEvent{TransferID: id, Name: name})
	m.bus.Publish("transfer-progress", transferProgressEvent{
		TransferID: id, Name: name, ChunksDone: 0, ChunksTotal: chunks, SizeBytes: sizeBytes,
	})

	for i := 0; i < chunks; i++ {
		if abortCtx.Err() != nil {
			announceCancelLoopback()
			return abortCtx.Err()
		}
		start := i * transferRawChunk
		end := start + transferRawChunk
		if end > len(data) {
			end = len(data)
		}
		chunkFrame := map[string]any{
			"type":        "file-chunk",
			"transfer_id": id,
			"idx":         i,
			"data":        base64.RawStdEncoding.EncodeToString(data[start:end]),
		}
		raw, err := json.Marshal(chunkFrame)
		if err != nil {
			m.bus.Publish("transfer-failed", transferLifecycleEvent{TransferID: id, Name: name, Reason: "marshal chunk: " + err.Error()})
			return fmt.Errorf("marshal chunk: %w", err)
		}
		m.handleInboundTransferFrame("file-chunk", raw, loopbackSessionFP, sess, nil, direction)
		m.bus.Publish("transfer-progress", transferProgressEvent{
			TransferID: id, Name: name, ChunksDone: i + 1, ChunksTotal: chunks, SizeBytes: sizeBytes,
		})
	}
	m.bus.Publish("transfer-completed", transferLifecycleEvent{TransferID: id, Name: name})
	return nil
}

// writeTransfer is shared by both directions. sess is non-nil only when
// the manager is sending to a session (so seq numbers stay monotonic on
// that session's counter). The id is generated by the caller (the HTTP
// handler) so the browser can subscribe to lifecycle events on it
// before the first chunk hits the wire. Publishes transfer-progress on
// the local bus after each chunk and transfer-completed / -failed at
// end so the sender's UI can show a live progress bar without polling.
//
// Loopback short-circuit: when the session is the synthetic loopback
// session, frames don't go over a WS — they're dispatched straight into
// the receive path so the inbox + lifecycle events fire as if a remote
// peer had sent them. Direction "from-manager" because the manager
// browser is the sender on this path.
func (m *modeState) writeTransfer(conn *websocket.Conn, sess *session, id, name, mime string, data []byte) error {
	if sess != nil && sess.loopback {
		return m.writeTransferLoopback(sess, id, name, mime, data, "from-manager")
	}
	chunks := (len(data) + transferRawChunk - 1) / transferRawChunk
	if chunks == 0 {
		chunks = 1
	}
	sizeBytes := int64(len(data))

	// Per-transfer abort context: CancelOutbound flips this when the
	// user clicks Cancel, which makes the next chunk's writeFrame return
	// immediately with ctx.Err() instead of writing to the wire.
	abortCtx, abortFn := context.WithCancel(context.Background())
	m.registerOutbound(id, name, abortFn)
	defer m.unregisterOutbound(id)
	defer abortFn()

	canceledBySender := func() bool { return abortCtx.Err() != nil }
	announceCancel := func() {
		sendCancel(conn, sess, id, "canceled by sender")
		m.bus.Publish("transfer-failed", transferLifecycleEvent{TransferID: id, Name: name, Reason: "canceled by sender"})
	}

	offer := map[string]any{
		"type":        "file-offer",
		"transfer_id": id,
		"name":        name,
		"size_bytes":  len(data),
		"mime":        mime,
		"chunks":      chunks,
	}
	stampSeq(sess, offer)
	offerCtx, cancel := context.WithTimeout(abortCtx, 10*time.Second)
	if err := writeFrame(offerCtx, conn, offer); err != nil {
		cancel()
		if canceledBySender() {
			announceCancel()
			return abortCtx.Err()
		}
		m.bus.Publish("transfer-failed", transferLifecycleEvent{TransferID: id, Name: name, Reason: "send offer: " + err.Error()})
		return fmt.Errorf("send offer: %w", err)
	}
	cancel()
	// Initial progress beat lets the sender's UI show 0/N immediately
	// rather than waiting until the first chunk is on the wire.
	m.bus.Publish("transfer-progress", transferProgressEvent{
		TransferID: id, Name: name, ChunksDone: 0, ChunksTotal: chunks, SizeBytes: sizeBytes,
	})

	for i := 0; i < chunks; i++ {
		if canceledBySender() {
			announceCancel()
			return abortCtx.Err()
		}
		start := i * transferRawChunk
		end := start + transferRawChunk
		if end > len(data) {
			end = len(data)
		}
		frame := map[string]any{
			"type":        "file-chunk",
			"transfer_id": id,
			"idx":         i,
			"data":        base64.RawStdEncoding.EncodeToString(data[start:end]),
		}
		stampSeq(sess, frame)
		ctx, ccancel := context.WithTimeout(abortCtx, transferChunkWriteTimeout)
		err := writeFrame(ctx, conn, frame)
		ccancel()
		if err != nil {
			if canceledBySender() {
				announceCancel()
				return abortCtx.Err()
			}
			m.bus.Publish("transfer-failed", transferLifecycleEvent{
				TransferID: id, Name: name,
				Reason: fmt.Sprintf("send chunk %d/%d: %v", i+1, chunks, err),
			})
			return fmt.Errorf("send chunk %d/%d: %w", i+1, chunks, err)
		}
		m.bus.Publish("transfer-progress", transferProgressEvent{
			TransferID: id, Name: name, ChunksDone: i + 1, ChunksTotal: chunks, SizeBytes: sizeBytes,
		})
	}
	m.bus.Publish("transfer-completed", transferLifecycleEvent{TransferID: id, Name: name})
	return nil
}

// sendCancel writes a file-cancel frame to the peer. Best-effort — the
// transfer is being torn down either way. No-op when conn is nil
// (loopback has no peer to notify).
func sendCancel(conn *websocket.Conn, sess *session, id, reason string) {
	if conn == nil {
		return
	}
	frame := map[string]any{
		"type":        "file-cancel",
		"transfer_id": id,
		"reason":      reason,
	}
	stampSeq(sess, frame)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = writeFrame(ctx, conn, frame)
}

func stampSeq(sess *session, msg map[string]any) {
	if sess == nil {
		return
	}
	sess.mu.Lock()
	sess.nextSeq++
	msg["seq"] = sess.nextSeq
	sess.mu.Unlock()
}

// ---- Frame decoders (used by mode.go's read loops) -----------------------

func decodeOffer(raw []byte) (fileOfferFrame, error) {
	var f fileOfferFrame
	if err := json.Unmarshal(raw, &f); err != nil {
		return fileOfferFrame{}, fmt.Errorf("decode offer: %w", err)
	}
	return f, nil
}

func decodeChunkFrame(raw []byte) (fileChunkFrame, error) {
	var f fileChunkFrame
	if err := json.Unmarshal(raw, &f); err != nil {
		return fileChunkFrame{}, fmt.Errorf("decode chunk: %w", err)
	}
	return f, nil
}

func decodeCancel(raw []byte) (fileCancelFrame, error) {
	var f fileCancelFrame
	if err := json.Unmarshal(raw, &f); err != nil {
		return fileCancelFrame{}, fmt.Errorf("decode cancel: %w", err)
	}
	return f, nil
}

func decodeAccept(raw []byte) (fileAcceptFrame, error) {
	var f fileAcceptFrame
	if err := json.Unmarshal(raw, &f); err != nil {
		return fileAcceptFrame{}, fmt.Errorf("decode accept: %w", err)
	}
	return f, nil
}

// sendAccept writes a file-accept frame back to the sender after the
// receiver's startInbound succeeded. Best-effort — failure here just
// means the sender won't see the "Accepted" toast; the actual transfer
// proceeds either way. No-op for loopback (conn is nil; the loopback
// writer publishes transfer-accepted directly instead).
func sendAccept(conn *websocket.Conn, sess *session, id string) {
	if conn == nil {
		return
	}
	frame := map[string]any{
		"type":        "file-accept",
		"transfer_id": id,
	}
	stampSeq(sess, frame)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = writeFrame(ctx, conn, frame)
}

// decodeFilenameHeader decodes an X-Transfer-Filename header value. Senders
// URL-encode the filename to keep header parsing strict; receivers reverse
// that. Falls back to the raw value on decode error so a slightly off
// client still gets a usable name.
func decodeFilenameHeader(v string) string {
	if v == "" {
		return "untitled"
	}
	if d, err := url.QueryUnescape(v); err == nil && d != "" {
		return d
	}
	return v
}
