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

	// Bookkeeping
	enteredAt       time.Time
	lastClientEvent time.Time

	appName string
	bus     *eventBus
	store   *configStore // for pushing current config to clients on connect
}

func newModeState(appName string, bus *eventBus, store *configStore) *modeState {
	return &modeState{
		current:  modeStandalone,
		sessions: make(map[string]*session),
		appName:  appName,
		bus:      bus,
		store:    store,
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
			Connected:   s.wsConn != nil,
			CreatedAt:   s.createdAt,
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

	m.sessions = make(map[string]*session)
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

	m.bus.Publish("mode-change", m.Snapshot())
}

// Quickstart is the one-button "Generate connection string" flow: detect
// the public IP, enter manager mode (if not already), and mint a session
// URL — all in one round trip. The port is fixed; the practitioner
// never sees or types a number.
func (m *modeState) Quickstart() (string, sessionSnapshot, error) {
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
	return m.CreateSession()
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

func (m *modeState) CreateSession() (string, sessionSnapshot, error) {
	m.mu.Lock()
	if m.current != modeManager {
		m.mu.Unlock()
		return "", sessionSnapshot{}, errors.New("not in manager mode")
	}
	practitioner := m.practitioner
	publicEP := m.publicEP
	m.mu.Unlock()

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
	m.mu.Unlock()

	snap := sessionSnapshot{
		Fingerprint: fp,
		Connected:   false,
		CreatedAt:   now,
	}
	m.bus.Publish("session-created", snap)
	return url, snap, nil
}

func (m *modeState) RemoveSession(fp string) error {
	m.mu.Lock()
	sess, ok := m.sessions[fp]
	if ok {
		delete(m.sessions, fp)
	}
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("no session %s", fp)
	}
	sess.closeWS(websocket.StatusNormalClosure, "removed by manager")
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

// SendVerb forwards a manager-UI verb to the session's WS as a frame.
func (m *modeState) SendVerb(fp string, verb json.RawMessage) error {
	sess := m.lookupSession(fp)
	if sess == nil {
		return fmt.Errorf("no session %s", fp)
	}
	sess.mu.Lock()
	conn := sess.wsConn
	sess.nextSeq++
	seq := sess.nextSeq
	sess.mu.Unlock()
	if conn == nil {
		return errors.New("session not connected")
	}

	var msg map[string]any
	if err := json.Unmarshal(verb, &msg); err != nil {
		return fmt.Errorf("decode verb: %w", err)
	}
	if _, ok := msg["type"].(string); !ok {
		return errors.New("verb missing 'type'")
	}
	msg["seq"] = seq

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
	m.mu.Unlock()
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
	m.managerReadLoop(ctx, sess, conn)

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
	m.mu.Unlock()
	if stillRegistered {
		m.bus.Publish("session-disconnected", map[string]any{"fingerprint": fp})
	}
}

func (m *modeState) managerReadLoop(ctx context.Context, sess *session, conn *websocket.Conn) {
	for {
		readCtx, cancel := context.WithTimeout(ctx, linkReadTimeout)
		hdr, raw, err := readFrame(readCtx, conn)
		cancel()
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("manager read (session %s): %v", sess.certFP[:8], err)
			}
			return
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
		// All manager-originated frames are verbs in client mode.
		// Push the raw frame to the browser via SSE; app.js decodes
		// fields it cares about and calls dispatch().
		m.bus.Publish("network-verb", map[string]any{
			"type":  hdr.Type,
			"seq":   hdr.Seq,
			"frame": json.RawMessage(raw),
		})
	}
	// Read loop exited → manager dropped or context cancelled.
	m.bus.Publish("network-disconnected", map[string]any{})
}

// ClientSend forwards an arbitrary message from the local browser
// (state, sequences, etc.) to the manager. Only valid in client mode.
func (m *modeState) ClientSend(msg map[string]any) error {
	m.mu.Lock()
	conn := m.clientConn
	mode := m.current
	m.mu.Unlock()
	if mode != modeClient {
		return errors.New("not in client mode")
	}
	if conn == nil {
		return errors.New("not connected")
	}
	if _, ok := msg["type"].(string); !ok {
		return errors.New("message missing 'type'")
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
