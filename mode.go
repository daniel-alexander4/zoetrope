// mode.go: per-binary mode state (standalone / manager / client) plus the
// HTTP endpoints that transition between modes, the manager-side listener
// + session table, and the client-side dialer.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	modeStandalone = "standalone"
	modeManager    = "manager"
	modeClient     = "client"

	// loopbackSessionFP is the well-known fingerprint of the synthetic
	// session created by Loopback(). Verb / state / file routing checks
	// this so frames short-circuit through the bus instead of a (nil) WS.
	loopbackSessionFP = "loopback"

	// Hardcoded so practitioners never have to think about ports. The
	// router-side port-forward and the client-side URL both assume this.
	managerHardcodedPort = "38130"
	managerListenAddr    = ":" + managerHardcodedPort

	managerIdleShutdown = 30 * time.Minute
	sessionURLTTL       = 10 * time.Minute
	heartbeatTimeout    = 90 * time.Second // browser-heartbeat watchdog (standalone/client only)

	// Public-IP echo service used by Quickstart. api64.* returns whichever
	// family the request egresses on (v4 or v6). One deliberate outbound
	// call, user-initiated (a button click), no identifying data sent.
	ipDetectURL = "https://api64.ipify.org/?format=json"
)

// session is one manager-side session: the client cert the manager
// generated (and is now waiting to see), plus the live WS connection
// once the client has paired.
type session struct {
	certDER   []byte
	certFP    string
	keyDER    []byte // PKCS#8 DER (kept so we can rebuild the URL if asked)
	createdAt time.Time

	mu      sync.Mutex
	label   string
	wsConn  *websocket.Conn
	nextSeq uint64

	// loopback is true for the synthetic session created by Loopback().
	// Routing branches in SendVerb / writeTransfer / Snapshot test this
	// instead of poking at fields the WS path would mutate.
	loopback bool
}

// closeWS closes the WS connection if any, holding the session lock so
// concurrent reads/writes coordinate.
func (s *session) closeWS(status websocket.StatusCode, reason string) {
	s.mu.Lock()
	conn := s.wsConn
	s.wsConn = nil
	s.mu.Unlock()
	if conn != nil {
		conn.Close(status, reason)
	}
}

// modeState owns the mode field plus the resources each mode acquires.
// Methods that change state hold the mutex; helpers consulted by the TLS
// verifier and WS handlers (hasSessionFP, lookupSession) acquire it
// briefly and never block on I/O.
type modeState struct {
	mu       sync.Mutex
	current  string
	sessions map[string]*session

	// Manager mode
	practitioner *practitionerIdentity
	listener     net.Listener
	httpServer   *http.Server
	publicEP     string
	listenAddr   string

	// Client mode
	clientConn     *websocket.Conn
	clientCancel   context.CancelFunc
	clientPeerFP   string // pinned manager fingerprint, for UI display
	clientEndpoint string

	// File transfers (see transfer.go). Held on modeState rather than per
	// session so the client-mode (single-peer) and manager-mode (multi-peer)
	// paths share one table; entries record sourceFP for routing.
	transferMu  sync.Mutex
	inProgress  map[string]*transferRX
	inbox       map[string]*inboxEntry
	outProgress map[string]*transferTX // in-flight outbound transfers, keyed by transfer_id; populated by writeTransfer for the CancelOutbound API

	// Client manager (see clients.go). Bindings live alongside the session
	// table: sessionClients maps cert-fp → client-id for sessions that were
	// minted "for client X"; activeSessionLogs maps cert-fp → session-log-id
	// for the currently-in-progress log entry so disconnect can finalize it.
	clients           *clientsStore
	sessionClients    map[string]string // cert fp → client id
	activeSessionLogs map[string]string // cert fp → session log id

	// Bookkeeping
	enteredAt       time.Time
	lastClientEvent time.Time

	appName string
	bus     *eventBus
	store   *configStore // for pushing current config to clients on connect
}

func newModeState(appName string, bus *eventBus, store *configStore, clients *clientsStore) *modeState {
	return &modeState{
		current:           modeStandalone,
		sessions:          make(map[string]*session),
		inProgress:        make(map[string]*transferRX),
		inbox:             make(map[string]*inboxEntry),
		outProgress:       make(map[string]*transferTX),
		clients:           clients,
		sessionClients:    make(map[string]string),
		activeSessionLogs: make(map[string]string),
		appName:           appName,
		bus:               bus,
		store:             store,
	}
}

// ---- Snapshots -------------------------------------------------------

type modeSnapshot struct {
	Mode           string            `json:"mode"`
	PractitionerFP string            `json:"practitioner_fp,omitempty"`
	PublicEndpoint string            `json:"public_endpoint,omitempty"`
	ListenAddr     string            `json:"listen_addr,omitempty"`
	Sessions       []sessionSnapshot `json:"sessions,omitempty"`
	ClientPeerFP   string            `json:"client_peer_fp,omitempty"`
	ClientEndpoint string            `json:"client_endpoint,omitempty"`
}

type sessionSnapshot struct {
	Fingerprint string    `json:"fingerprint"`
	Label       string    `json:"label,omitempty"`
	Connected   bool      `json:"connected"`
	CreatedAt   time.Time `json:"created_at"`
	ClientID    string    `json:"client_id,omitempty"`
}

func (m *modeState) Snapshot() modeSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	snap := modeSnapshot{
		Mode:           m.current,
		PublicEndpoint: m.publicEP,
		ListenAddr:     m.listenAddr,
		ClientPeerFP:   m.clientPeerFP,
		ClientEndpoint: m.clientEndpoint,
	}
	if m.practitioner != nil {
		snap.PractitionerFP = m.practitioner.Fingerprint
	}
	for fp, s := range m.sessions {
		s.mu.Lock()
		snap.Sessions = append(snap.Sessions, sessionSnapshot{
			Fingerprint: fp,
			Label:       s.label,
			Connected:   s.wsConn != nil || s.loopback,
			CreatedAt:   s.createdAt,
			ClientID:    m.sessionClients[fp],
		})
		s.mu.Unlock()
	}
	return snap
}

func (m *modeState) Mode() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.current
}

func (m *modeState) hasSessionFP(fp string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.sessions[fp]
	return ok
}

func (m *modeState) lookupSession(fp string) *session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[fp]
}

// ShouldShutdown is called by main's watchdog. Standalone and client use
// the existing browser-heartbeat-based shutdown; manager uses a longer
// idle window that resets on each client connect / disconnect.
func (m *modeState) ShouldShutdown(hb *heartbeat) bool {
	m.mu.Lock()
	mode := m.current
	enteredAt := m.enteredAt
	lastEvent := m.lastClientEvent
	anyConnected := false
	for _, s := range m.sessions {
		s.mu.Lock()
		if s.wsConn != nil {
			anyConnected = true
		}
		s.mu.Unlock()
		if anyConnected {
			break
		}
	}
	m.mu.Unlock()

	switch mode {
	case modeManager:
		if anyConnected {
			return false
		}
		ref := lastEvent
		if ref.IsZero() {
			ref = enteredAt
		}
		return time.Since(ref) > managerIdleShutdown
	case modeClient:
		// Client mode is browser-visible; if the tab closes, we want to
		// exit. Same as standalone.
		return hb.Stale(heartbeatTimeout)
	default:
		return hb.Stale(heartbeatTimeout)
	}
}

// ---- Mode transitions ------------------------------------------------

type hostRequest struct {
	Endpoint string `json:"endpoint"` // host:port — what clients dial
}

func (m *modeState) Host(req hostRequest) error {
	if req.Endpoint == "" {
		return errors.New("endpoint is required")
	}
	listenAddr := managerListenAddr

	idPath, err := practitionerIdentityPath(m.appName)
	if err != nil {
		return fmt.Errorf("identity path: %w", err)
	}
	id, err := loadOrCreatePractitionerIdentity(idPath)
	if err != nil {
		return fmt.Errorf("practitioner identity: %w", err)
	}

	m.mu.Lock()
	// Idempotent for re-engage: already in manager mode → no-op, return
	// success. This is what the /manage Landing button's POST hits when
	// the frontend's in-memory state.nmode is stale; without idempotency
	// the user sees a 400 and "click did nothing." Client mode is still
	// a real conflict — joining-as-client and wanting-to-host need a
	// deliberate leave first.
	if m.current == modeManager {
		m.mu.Unlock()
		return nil
	}
	if m.current != modeStandalone {
		m.mu.Unlock()
		return fmt.Errorf("already in %s mode", m.current)
	}
	m.mu.Unlock()

	tlsCfg := serverTLSConfig(id.tlsCertificate(), verifyKnownSessionCert(m.hasSessionFP))
	ln, err := tls.Listen("tcp", listenAddr, tlsCfg)
	if err != nil {
		return fmt.Errorf("listen %s: %w", listenAddr, err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", m.handleManagerWS)
	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: linkHandshakeTimeout,
	}

	m.mu.Lock()
	m.practitioner = id
	m.listener = ln
	m.httpServer = srv
	m.publicEP = req.Endpoint
	m.listenAddr = listenAddr
	m.current = modeManager
	m.enteredAt = time.Now()
	m.lastClientEvent = time.Time{}
	m.mu.Unlock()

	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("manager listener: %v", err)
		}
	}()

	m.bus.Publish("mode-change", m.Snapshot())
	return nil
}

// Loopback enters a development-only mode where one binary plays both
// sides locally: backend is in manager mode (no external listener) with
// a synthetic session whose verbs / state / file transfer round-trip
// through the SSE bus instead of an mTLS WebSocket. The /manage tab and
// a /?loopback tab share the same Go process and exchange the entire
// protocol surface so /scrutinize and /tshoot can exercise it on one
// machine. No public IP, no cert, no port-forward.
func (m *modeState) Loopback() error {
	idPath, err := practitionerIdentityPath(m.appName)
	if err != nil {
		return fmt.Errorf("identity path: %w", err)
	}
	id, err := loadOrCreatePractitionerIdentity(idPath)
	if err != nil {
		return fmt.Errorf("practitioner identity: %w", err)
	}

	m.mu.Lock()
	if m.current != modeStandalone {
		m.mu.Unlock()
		return fmt.Errorf("already in %s mode", m.current)
	}
	now := time.Now()
	sess := &session{
		certFP:    loopbackSessionFP,
		createdAt: now,
		label:     "loopback (dev)",
		loopback:  true,
	}
	m.practitioner = id
	m.publicEP = ""
	m.listenAddr = ""
	m.current = modeManager
	m.enteredAt = now
	m.lastClientEvent = now
	m.sessions[loopbackSessionFP] = sess
	m.mu.Unlock()

	m.bus.Publish("mode-change", m.Snapshot())
	m.bus.Publish("session-created", sessionSnapshot{
		Fingerprint: loopbackSessionFP,
		Label:       "loopback (dev)",
		Connected:   true,
		CreatedAt:   now,
	})
	m.bus.Publish("session-connected", sessionSnapshot{
		Fingerprint: loopbackSessionFP,
		Label:       "loopback (dev)",
		Connected:   true,
		CreatedAt:   now,
	})
	return nil
}

type joinRequest struct {
	URL   string `json:"url"`
	Label string `json:"label,omitempty"`
}

func (m *modeState) Join(req joinRequest) error {
	if req.URL == "" {
		return errors.New("url is required")
	}
	endpoint, payload, err := parseSessionURL(req.URL)
	if err != nil {
		return fmt.Errorf("parse session url: %w", err)
	}

	// Reconstruct the client cert / key from the URL payload.
	cert, err := x509.ParseCertificate(payload.ClientCert)
	if err != nil {
		return fmt.Errorf("parse client cert: %w", err)
	}
	keyAny, err := x509.ParsePKCS8PrivateKey(payload.ClientKey)
	if err != nil {
		return fmt.Errorf("parse client key: %w", err)
	}
	tlsCert := tls.Certificate{
		Certificate: [][]byte{payload.ClientCert},
		PrivateKey:  keyAny,
		Leaf:        cert,
	}

	m.mu.Lock()
	if m.current != modeStandalone {
		m.mu.Unlock()
		return fmt.Errorf("already in %s mode", m.current)
	}
	m.mu.Unlock()

	// Strip a leading scheme if the user supplied a wss:// URL by mistake;
	// dialWebSocket reapplies wss://.
	endpoint = trimScheme(endpoint)

	ctx, cancel := context.WithCancel(context.Background())
	conn, err := dialWebSocket(ctx, endpoint, tlsCert, verifyPinnedPeerCert(payload.ManagerFP))
	if err != nil {
		cancel()
		return fmt.Errorf("dial manager: %w", err)
	}

	m.mu.Lock()
	m.clientConn = conn
	m.clientCancel = cancel
	m.clientPeerFP = payload.ManagerFP
	m.clientEndpoint = endpoint
	m.current = modeClient
	m.enteredAt = time.Now()
	m.mu.Unlock()

	go m.clientReadLoop(ctx, conn)
	go pingLoop(ctx, conn)

	// Send hello to the manager.
	hello := map[string]any{"type": "hello"}
	if req.Label != "" {
		hello["label"] = req.Label
	}
	if err := writeFrame(ctx, conn, hello); err != nil {
		log.Printf("client hello: %v", err)
	}

	m.bus.Publish("mode-change", m.Snapshot())
	return nil
}

func (m *modeState) Standalone() {
	m.mu.Lock()
	if m.current == modeStandalone {
		m.mu.Unlock()
		return
	}

	sessions := m.sessions
	httpServer := m.httpServer
	listener := m.listener
	clientCancel := m.clientCancel
	clientConn := m.clientConn
	// Snapshot in-flight session logs so we can finalize them after the
	// disconnect path has had a chance to fire. After the map is cleared
	// below, the deferred read-loop exits will find empty maps and skip.
	pendingLogs := make(map[string]string, len(m.activeSessionLogs))
	for fp, logID := range m.activeSessionLogs {
		if cid, ok := m.sessionClients[fp]; ok {
			pendingLogs[cid] = logID
		}
	}

	m.sessions = make(map[string]*session)
	m.sessionClients = make(map[string]string)
	m.activeSessionLogs = make(map[string]string)
	m.httpServer = nil
	m.listener = nil
	m.clientConn = nil
	m.clientCancel = nil
	m.publicEP = ""
	m.listenAddr = ""
	m.clientPeerFP = ""
	m.clientEndpoint = ""
	m.practitioner = nil
	m.current = modeStandalone
	m.enteredAt = time.Now()
	m.mu.Unlock()

	// Best-effort finalize any logs whose disconnect path didn't get to fire
	// (e.g., the practitioner clicked Stop Hosting while a call was live).
	if m.clients != nil {
		for cid, logID := range pendingLogs {
			if err := m.clients.EndSession(cid, logID); err != nil {
				log.Printf("client log end on standalone (client %s, log %s): %v", cid, logID, err)
			}
		}
	}

	// Close everything outside the mutex to avoid deadlocking against
	// in-flight WS handlers that need the lock.
	for _, s := range sessions {
		s.closeWS(websocket.StatusGoingAway, "host stopped")
	}
	if httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = httpServer.Shutdown(ctx)
		cancel()
	}
	if listener != nil {
		_ = listener.Close()
	}
	if clientCancel != nil {
		clientCancel()
	}
	if clientConn != nil {
		clientConn.Close(websocket.StatusGoingAway, "client leaving")
	}
	m.resetTransfers()

	m.bus.Publish("mode-change", m.Snapshot())
}

// Quickstart is the one-button "Generate connection string" flow: detect
// the public IP, enter manager mode (if not already), and mint a session
// URL — all in one round trip. The port is fixed; the practitioner
// never sees or types a number. clientID, when non-empty, binds the
// generated session to that client (see CreateSession).
func (m *modeState) Quickstart(clientID string) (string, sessionSnapshot, error) {
	if m.Mode() != modeManager {
		ip, err := detectPublicIP(context.Background())
		if err != nil {
			return "", sessionSnapshot{}, fmt.Errorf("detect public IP: %w", err)
		}
		endpoint := net.JoinHostPort(ip, managerHardcodedPort)
		if err := m.Host(hostRequest{Endpoint: endpoint}); err != nil {
			return "", sessionSnapshot{}, err
		}
	}
	return m.CreateSession(clientID)
}

// detectPublicIP asks a public IP-echo service for our externally-visible
// address. One deliberate outbound call, user-initiated (a button click);
// flagged in CLAUDE.md / README so it isn't a surprise.
func detectPublicIP(parent context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", ipDetectURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "zoetrope/"+version)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("ipify status %d", resp.StatusCode)
	}
	var out struct {
		IP string `json:"ip"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1024)).Decode(&out); err != nil {
		return "", fmt.Errorf("decode ipify response: %w", err)
	}
	if out.IP == "" {
		return "", errors.New("empty IP from ipify")
	}
	return out.IP, nil
}

func trimScheme(endpoint string) string {
	for _, prefix := range []string{"wss://", "ws://", "https://", "http://"} {
		if len(endpoint) > len(prefix) && endpoint[:len(prefix)] == prefix {
			return endpoint[len(prefix):]
		}
	}
	return endpoint
}

// ---- Manager: session creation + verb forwarding --------------------

// CreateSession mints a fresh ephemeral session cert + URL. When clientID
// is non-empty, the session is bound to that client and its lifecycle (WS
// pair → BeginSession, WS disconnect → EndSession) is logged into the
// client's record on disk. An empty clientID creates an unattached session
// (current behavior, no logging).
func (m *modeState) CreateSession(clientID string) (string, sessionSnapshot, error) {
	m.mu.Lock()
	if m.current != modeManager {
		m.mu.Unlock()
		return "", sessionSnapshot{}, errors.New("not in manager mode")
	}
	practitioner := m.practitioner
	publicEP := m.publicEP
	m.mu.Unlock()

	if clientID != "" {
		if m.clients == nil || !m.clients.Exists(clientID) {
			return "", sessionSnapshot{}, fmt.Errorf("unknown client_id %q", clientID)
		}
	}

	sid, err := generateSessionIdentity()
	if err != nil {
		return "", sessionSnapshot{}, fmt.Errorf("gen session identity: %w", err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(sid.PrivateKey)
	if err != nil {
		return "", sessionSnapshot{}, fmt.Errorf("marshal session key: %w", err)
	}
	fp := sid.fingerprint()
	now := time.Now()
	sess := &session{
		certDER:   sid.CertDER,
		certFP:    fp,
		keyDER:    keyDER,
		createdAt: now,
	}

	payload := sessionPayload{
		ClientCert: sid.CertDER,
		ClientKey:  keyDER,
		ManagerFP:  practitioner.Fingerprint,
		TTLUnix:    now.Add(sessionURLTTL).Unix(),
	}
	url, err := buildSessionURL(publicEP, payload)
	if err != nil {
		return "", sessionSnapshot{}, err
	}

	m.mu.Lock()
	m.sessions[fp] = sess
	if clientID != "" {
		m.sessionClients[fp] = clientID
	}
	m.mu.Unlock()

	snap := sessionSnapshot{
		Fingerprint: fp,
		Connected:   false,
		CreatedAt:   now,
		ClientID:    clientID,
	}
	m.bus.Publish("session-created", snap)
	return url, snap, nil
}

func (m *modeState) RemoveSession(fp string) error {
	m.mu.Lock()
	sess, ok := m.sessions[fp]
	if ok {
		delete(m.sessions, fp)
		delete(m.sessionClients, fp)
		// If a log entry is still open (peer never disconnected before this
		// remove), the handleManagerWS deferred path will close the WS, the
		// read loop will exit, and the disconnect path above will end it.
		// No work to do here.
	}
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("no session %s", fp)
	}
	sess.closeWS(websocket.StatusNormalClosure, "removed by manager")
	m.dropTransfersForSession(fp)
	m.bus.Publish("session-removed", map[string]any{"fingerprint": fp})
	return nil
}

// pushConfig writes the current practitioner config to a session as a
// set-config frame. Called from handleManagerWS right after a WS pairs,
// so the client renders the practitioner's setup rather than its own
// local config.
func (m *modeState) pushConfig(ctx context.Context, sess *session, conn *websocket.Conn) error {
	if m.store == nil {
		return nil // no config store wired (shouldn't happen in main flow)
	}
	cfg := m.store.Get()
	sess.mu.Lock()
	sess.nextSeq++
	seq := sess.nextSeq
	sess.mu.Unlock()
	msg := map[string]any{
		"type":   "set-config",
		"seq":    seq,
		"config": cfg,
	}
	writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return writeFrame(writeCtx, conn, msg)
}

// BroadcastConfig pushes the current store config to every connected
// session. Called from the PUT /config handler after a successful
// configStore.Set() so practitioner edits (active playlist switch,
// global tweaks) propagate to active clients without a rejoin. No-op
// outside manager mode. Per-session errors are logged but don't abort
// the loop.
func (m *modeState) BroadcastConfig() {
	m.mu.Lock()
	if m.current != modeManager {
		m.mu.Unlock()
		return
	}
	type pair struct {
		sess *session
		conn *websocket.Conn
	}
	var live []pair
	for _, sess := range m.sessions {
		sess.mu.Lock()
		conn := sess.wsConn
		sess.mu.Unlock()
		if conn != nil {
			live = append(live, pair{sess, conn})
		}
	}
	m.mu.Unlock()
	if len(live) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, p := range live {
		if err := m.pushConfig(ctx, p.sess, p.conn); err != nil {
			log.Printf("broadcast config to session %s: %v", p.sess.certFP[:8], err)
		}
	}
}

// SendVerb forwards a manager-UI verb to the session's WS as a frame.
// For the synthetic loopback session, instead of writing to a (nil) WS
// the verb is published on the local SSE bus as a network-verb event so
// the in-tab "client" picks it up identically to the network path.
func (m *modeState) SendVerb(fp string, verb json.RawMessage) error {
	sess := m.lookupSession(fp)
	if sess == nil {
		return fmt.Errorf("no session %s", fp)
	}
	sess.mu.Lock()
	conn := sess.wsConn
	sess.nextSeq++
	seq := sess.nextSeq
	loopback := sess.loopback
	sess.mu.Unlock()
	if conn == nil && !loopback {
		return errors.New("session not connected")
	}

	var msg map[string]any
	if err := json.Unmarshal(verb, &msg); err != nil {
		return fmt.Errorf("decode verb: %w", err)
	}
	verbType, ok := msg["type"].(string)
	if !ok {
		return errors.New("verb missing 'type'")
	}
	msg["seq"] = seq

	if loopback {
		stamped, _ := json.Marshal(msg)
		m.bus.Publish("network-verb", map[string]any{
			"type":  verbType,
			"seq":   seq,
			"frame": json.RawMessage(stamped),
		})
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return writeFrame(ctx, conn, msg)
}

// ---- Manager: WebSocket handler -------------------------------------

func (m *modeState) handleManagerWS(w http.ResponseWriter, r *http.Request) {
	fp := peerFingerprintFromTLS(r)
	if fp == "" {
		http.Error(w, "no peer cert", http.StatusUnauthorized)
		return
	}
	sess := m.lookupSession(fp)
	if sess == nil {
		// The TLS verifier should have caught this, but defend in depth.
		http.Error(w, "unknown session", http.StatusUnauthorized)
		return
	}

	conn, err := acceptWebSocket(w, r)
	if err != nil {
		log.Printf("ws accept (session %s): %v", fp[:8], err)
		return
	}

	// Replace any prior connection for this session (rejoin path).
	sess.mu.Lock()
	prior := sess.wsConn
	sess.wsConn = conn
	sess.mu.Unlock()
	if prior != nil {
		prior.Close(websocket.StatusGoingAway, "superseded by new connection")
	}

	m.mu.Lock()
	m.lastClientEvent = time.Now()
	clientID := m.sessionClients[fp]
	m.mu.Unlock()

	// If the session was minted "for client X", open a session-log entry.
	// Disconnect (below) finalizes it. Failure is non-fatal — log and carry
	// on; the practitioner still gets a working session.
	if clientID != "" && m.clients != nil {
		if logID, err := m.clients.BeginSession(clientID, fp); err != nil {
			log.Printf("client log begin (session %s, client %s): %v", fp[:8], clientID, err)
		} else {
			m.mu.Lock()
			m.activeSessionLogs[fp] = logID
			m.mu.Unlock()
		}
	}

	m.bus.Publish("session-connected", sessionSnapshot{
		Fingerprint: fp,
		Connected:   true,
		CreatedAt:   sess.createdAt,
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Push the practitioner's current config so the client renders what
	// was set up on /manage, not their own local config. Fires on every
	// WS pair (initial + rejoin) so a refreshed client recovers without
	// the practitioner having to do anything.
	if err := m.pushConfig(ctx, sess, conn); err != nil {
		log.Printf("push config to session %s: %v", fp[:8], err)
		conn.Close(websocket.StatusInternalError, "config push failed")
		return
	}

	go pingLoop(ctx, conn)
	reason := m.managerReadLoop(ctx, sess, conn)

	// Reader returned — connection is dead from our perspective.
	sess.mu.Lock()
	if sess.wsConn == conn {
		sess.wsConn = nil
	}
	sess.mu.Unlock()
	conn.Close(websocket.StatusNormalClosure, "")

	m.mu.Lock()
	m.lastClientEvent = time.Now()
	stillRegistered := m.sessions[fp] != nil
	logID := m.activeSessionLogs[fp]
	logClient := m.sessionClients[fp]
	delete(m.activeSessionLogs, fp)
	m.mu.Unlock()
	if logID != "" && logClient != "" && m.clients != nil {
		if err := m.clients.EndSession(logClient, logID); err != nil {
			log.Printf("client log end (session %s, client %s): %v", fp[:8], logClient, err)
		}
	}
	if stillRegistered {
		m.bus.Publish("session-disconnected", map[string]any{
			"fingerprint": fp,
			"reason":      reason,
		})
	}
}

// managerReadLoop reads frames from a session WS until the connection
// closes. Returns "left" when the peer closed cleanly (StatusNormalClosure
// / StatusGoingAway) and "dropped" otherwise. The caller publishes this on
// the session-disconnected SSE event so the manager UI can distinguish a
// client clicking Leave from a network drop or watchdog timeout.
func (m *modeState) managerReadLoop(ctx context.Context, sess *session, conn *websocket.Conn) string {
	for {
		readCtx, cancel := context.WithTimeout(ctx, linkReadTimeout)
		hdr, raw, err := readFrame(readCtx, conn)
		cancel()
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("manager read (session %s): %v", sess.certFP[:8], err)
			}
			code := websocket.CloseStatus(err)
			if code == websocket.StatusNormalClosure || code == websocket.StatusGoingAway {
				return "left"
			}
			return "dropped"
		}
		switch hdr.Type {
		case "hello":
			var h struct {
				Label string `json:"label"`
			}
			_ = json.Unmarshal(raw, &h)
			sess.mu.Lock()
			sess.label = h.Label
			sess.mu.Unlock()
			m.bus.Publish("session-hello", map[string]any{
				"fingerprint": sess.certFP,
				"label":       h.Label,
			})
		case "state", "sequences", "config":
			m.bus.Publish("session-"+hdr.Type, map[string]any{
				"fingerprint": sess.certFP,
				"payload":     json.RawMessage(raw),
			})
		case "audio-offer", "audio-answer", "audio-ice", "audio-bye":
			// Voice-call signaling: the browsers own RTCPeerConnection
			// lifecycle and the SDP/ICE state machine. We just route the
			// frame through to /manage's SSE bus tagged with the source fp
			// so audio.js knows which session is speaking.
			m.bus.Publish("session-"+hdr.Type, map[string]any{
				"fingerprint": sess.certFP,
				"payload":     json.RawMessage(raw),
			})
		case "capture-response", "capture-revoke":
			// Session-audio recording: client-side replies. response is
			// the consent answer to a capture-request; revoke is the
			// client withdrawing consent mid-recording. The /manage
			// browser handles both via session-* SSE events.
			m.bus.Publish("session-"+hdr.Type, map[string]any{
				"fingerprint": sess.certFP,
				"payload":     json.RawMessage(raw),
			})
		case "file-offer", "file-chunk", "file-cancel", "file-accept":
			m.handleInboundTransferFrame(hdr.Type, raw, sess.certFP, sess, conn, "from-session")
		default:
			log.Printf("manager: unknown frame type %q from session %s", hdr.Type, sess.certFP[:8])
		}
	}
}

// ---- Client: read loop + upstream sends ------------------------------

func (m *modeState) clientReadLoop(ctx context.Context, conn *websocket.Conn) {
	for {
		readCtx, cancel := context.WithTimeout(ctx, linkReadTimeout)
		hdr, raw, err := readFrame(readCtx, conn)
		cancel()
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("client read: %v", err)
			}
			break
		}
		switch hdr.Type {
		case "file-offer", "file-chunk", "file-cancel", "file-accept":
			// File transfer terminates in the Go process (chunks reassemble
			// here, then the browser fetches the complete inbox entry).
			// Don't relay these to the browser SSE bus as plain verbs.
			m.handleInboundTransferFrame(hdr.Type, raw, "", nil, conn, "from-manager")
		default:
			// All manager-originated frames are verbs in client mode. Push
			// the raw frame to the browser via SSE; app.js decodes fields
			// it cares about and calls dispatch().
			m.bus.Publish("network-verb", map[string]any{
				"type":  hdr.Type,
				"seq":   hdr.Seq,
				"frame": json.RawMessage(raw),
			})
		}
	}
	// Read loop exited → manager dropped or context cancelled.
	m.bus.Publish("network-disconnected", map[string]any{})
}

// handleInboundTransferFrame routes one transfer-related frame. Shared by
// both read loops: sourceFP is the session fingerprint on the manager
// receive path and "" on the client receive path; sess is non-nil only on
// the manager path (so file-cancel echoes get a session-scoped seq).
// direction is the SSE event's direction field so the browser knows
// whether it should surface the notification.
func (m *modeState) handleInboundTransferFrame(verb string, raw []byte, sourceFP string, sess *session, conn *websocket.Conn, direction string) {
	switch verb {
	case "file-offer":
		offer, err := decodeOffer(raw)
		if err != nil {
			log.Printf("transfer offer decode: %v", err)
			return
		}
		cap := m.store.Get().MaxTransferBytes
		_, reject := m.startInbound(offer, sourceFP, cap)
		if reject != "" {
			log.Printf("transfer reject %s: %s", offer.TransferID, reject)
			sendCancel(conn, sess, offer.TransferID, reject)
			return
		}
		// Ack the offer so the sender's UI can flip from "Sending…" to
		// "Accepted, sending…". Informational — the sender is already
		// writing chunks.
		sendAccept(conn, sess, offer.TransferID)
	case "file-accept":
		acc, err := decodeAccept(raw)
		if err != nil {
			log.Printf("transfer accept decode: %v", err)
			return
		}
		m.bus.Publish("transfer-accepted", transferLifecycleEvent{TransferID: acc.TransferID})
	case "file-chunk":
		chunk, err := decodeChunkFrame(raw)
		if err != nil {
			log.Printf("transfer chunk decode: %v", err)
			return
		}
		rx, done, addErr := m.addChunk(chunk)
		if addErr != nil {
			log.Printf("transfer chunk %s: %v", chunk.TransferID, addErr)
			m.abortInbound(chunk.TransferID)
			sendCancel(conn, sess, chunk.TransferID, "chunk-error")
			return
		}
		if !done {
			return
		}
		m.mu.Lock()
		clientID := m.sessionClients[sourceFP]
		m.mu.Unlock()
		entry, ferr := m.finalizeInbound(rx, clientID)
		if ferr != nil {
			log.Printf("transfer finalize %s: %v", rx.id, ferr)
			sendCancel(conn, sess, rx.id, "storage-error")
			return
		}
		entryURL := "/api/inbox/" + entry.id
		if clientID != "" {
			entryURL = "/api/clients/" + clientID + "/inbox/" + entry.id
		}
		m.bus.Publish("file-received", fileReceivedEvent{
			TransferID: entry.id,
			Name:       entry.name,
			SizeBytes:  entry.sizeBytes,
			MIME:       entry.mime,
			SourceFP:   entry.sourceFP,
			Direction:  direction,
			ClientID:   clientID,
			EntryURL:   entryURL,
		})
	case "file-cancel":
		cancelFrame, err := decodeCancel(raw)
		if err != nil {
			log.Printf("transfer cancel decode: %v", err)
			return
		}
		m.abortInbound(cancelFrame.TransferID)
	}
}

// ClientSend forwards an arbitrary message from the local browser
// (state, sequences, etc.) to the manager. Valid in client mode (writes
// to the manager WS) or while a loopback session exists (publishes the
// equivalent session-* event on the local bus so the in-tab manager UI
// picks it up identically to the network path).
func (m *modeState) ClientSend(msg map[string]any) error {
	m.mu.Lock()
	conn := m.clientConn
	mode := m.current
	loopback := m.sessions[loopbackSessionFP] != nil
	m.mu.Unlock()
	verbType, ok := msg["type"].(string)
	if !ok {
		return errors.New("message missing 'type'")
	}
	if loopback {
		raw, err := json.Marshal(msg)
		if err != nil {
			return fmt.Errorf("marshal: %w", err)
		}
		m.bus.Publish("session-"+verbType, map[string]any{
			"fingerprint": loopbackSessionFP,
			"payload":     json.RawMessage(raw),
		})
		return nil
	}
	if mode != modeClient {
		return errors.New("not in client mode")
	}
	if conn == nil {
		return errors.New("not connected")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return writeFrame(ctx, conn, msg)
}

// ---- Ping keepalive --------------------------------------------------

func pingLoop(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(linkPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pctx, cancel := context.WithTimeout(ctx, linkReadTimeout)
			err := conn.Ping(pctx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}
