// link.go: the on-wire transport for manager↔client sessions.
//
//	TLS 1.3 with mutual auth via fingerprint pinning, WebSocket framing,
//	JSON verbs/events with a protocol-version header.
//
// Session lifecycle, HTTP routing, and goroutines live elsewhere; this
// file is the protocol primitive that mode wiring composes against.
package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/coder/websocket"
)

const (
	linkSubprotocol      = "zoetrope.v1"
	linkHandshakeTimeout = 10 * time.Second
	linkPingInterval     = 30 * time.Second
	linkReadTimeout      = 75 * time.Second
	linkMaxMessageBytes  = 256 * 1024
	protocolVersion      = 1
)

// frameHeader is the minimum every JSON frame on the wire must carry.
// Verb-specific fields ride at the top level alongside these — readers
// keep the raw bytes and decode fields they care about, writers merge
// extra fields into a single JSON object before sending.
type frameHeader struct {
	PV   int    `json:"pv"`
	Type string `json:"type"`
	Seq  uint64 `json:"seq,omitempty"`
}

// verifyPinnedPeerCert returns a tls.Config.VerifyPeerCertificate callback
// that succeeds iff the peer presents exactly the cert with the given
// SHA-256 fingerprint (hex). Constant-time compare; ignores the rest of
// the chain entirely (we don't use a CA).
func verifyPinnedPeerCert(expectedFingerprintHex string) func([][]byte, [][]*x509.Certificate) error {
	expected, err := hex.DecodeString(expectedFingerprintHex)
	if err != nil || len(expected) != sha256.Size {
		// Caller bug — return a callback that always fails closed.
		return func([][]byte, [][]*x509.Certificate) error {
			return fmt.Errorf("invalid pinned fingerprint %q", expectedFingerprintHex)
		}
	}
	return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if len(rawCerts) == 0 {
			return errors.New("peer presented no certificate")
		}
		got := sha256.Sum256(rawCerts[0])
		if subtle.ConstantTimeCompare(got[:], expected) != 1 {
			return errors.New("peer certificate fingerprint mismatch")
		}
		return nil
	}
}

// verifyKnownSessionCert returns a callback that accepts any client cert
// whose fingerprint is currently registered. Used by the manager listener
// to gate unknown peers at the TLS layer — no session state is allocated
// for connections that fail this check.
func verifyKnownSessionCert(known func(fp string) bool) func([][]byte, [][]*x509.Certificate) error {
	return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if len(rawCerts) == 0 {
			return errors.New("client presented no certificate")
		}
		if !known(fingerprintHex(rawCerts[0])) {
			return errors.New("client certificate not registered for any active session")
		}
		return nil
	}
}

// serverTLSConfig returns a tls.Config for a manager listener.
// VerifyPeerCertificate is the only validation layer — built-in chain
// validation is disabled because we don't use a CA.
func serverTLSConfig(presented tls.Certificate, verify func([][]byte, [][]*x509.Certificate) error) *tls.Config {
	return &tls.Config{
		MinVersion:            tls.VersionTLS13,
		MaxVersion:            tls.VersionTLS13,
		Certificates:          []tls.Certificate{presented},
		ClientAuth:            tls.RequireAnyClientCert,
		InsecureSkipVerify:    true, // VerifyPeerCertificate pins the fingerprint
		VerifyPeerCertificate: verify,
	}
}

// clientTLSConfig returns a tls.Config for a client dialer.
func clientTLSConfig(presented tls.Certificate, verify func([][]byte, [][]*x509.Certificate) error) *tls.Config {
	return &tls.Config{
		MinVersion:            tls.VersionTLS13,
		MaxVersion:            tls.VersionTLS13,
		Certificates:          []tls.Certificate{presented},
		InsecureSkipVerify:    true, // VerifyPeerCertificate pins the fingerprint
		VerifyPeerCertificate: verify,
	}
}

// sessionPayload is the URL-fragment payload — everything a client needs
// to dial a manager. Encoded as compact JSON, then base64url'd into the
// URL fragment so SMS/clipboard pipelines don't mangle it.
type sessionPayload struct {
	ClientCert []byte `json:"client_cert"` // DER
	ClientKey  []byte `json:"client_key"`  // PKCS#8 DER
	ManagerFP  string `json:"manager_fp"`  // hex SHA-256 of practitioner cert
	TTLUnix    int64  `json:"ttl_unix"`    // payload expiry (seconds since epoch)
}

// buildSessionURL constructs the practitioner-shared URL for a new session.
// endpoint is the practitioner's reachable address (host:port; bracketed
// for IPv6, e.g. "[2001:db8::1]:38130").
func buildSessionURL(endpoint string, payload sessionPayload) (string, error) {
	jb, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal payload: %w", err)
	}
	fragment := base64.RawURLEncoding.EncodeToString(jb)
	q := url.Values{}
	q.Set("ws", "wss://"+endpoint)
	return fmt.Sprintf("zoetrope://join?%s#%s", q.Encode(), fragment), nil
}

// parseSessionURL extracts the endpoint and payload from a pasted URL.
// Rejects expired payloads so a leaked link can't be replayed forever.
func parseSessionURL(raw string) (endpoint string, payload sessionPayload, err error) {
	u, perr := url.Parse(raw)
	if perr != nil {
		return "", sessionPayload{}, fmt.Errorf("parse url: %w", perr)
	}
	if u.Scheme != "zoetrope" {
		return "", sessionPayload{}, fmt.Errorf("scheme %q, want zoetrope", u.Scheme)
	}
	endpoint = u.Query().Get("ws")
	if endpoint == "" {
		return "", sessionPayload{}, errors.New("missing ws= parameter")
	}
	if u.Fragment == "" {
		return "", sessionPayload{}, errors.New("missing fragment payload")
	}
	jb, derr := base64.RawURLEncoding.DecodeString(u.Fragment)
	if derr != nil {
		return "", sessionPayload{}, fmt.Errorf("decode fragment: %w", derr)
	}
	if uerr := json.Unmarshal(jb, &payload); uerr != nil {
		return "", sessionPayload{}, fmt.Errorf("unmarshal payload: %w", uerr)
	}
	if time.Now().Unix() > payload.TTLUnix {
		return "", sessionPayload{}, errors.New("session URL expired")
	}
	return endpoint, payload, nil
}

// acceptWebSocket completes the WS upgrade on a connection that has
// already passed our TLS handshake. Origin checks are bypassed (the
// client is a Go binary with no Origin header); the subprotocol is
// required so a stray scanner that completes TLS by accident gets
// rejected before any session state is allocated.
func acceptWebSocket(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // origin-check skip (NOT a TLS field)
		Subprotocols:       []string{linkSubprotocol},
	})
	if err != nil {
		return nil, err
	}
	if conn.Subprotocol() != linkSubprotocol {
		conn.Close(websocket.StatusProtocolError, "subprotocol mismatch")
		return nil, fmt.Errorf("client did not negotiate %q", linkSubprotocol)
	}
	conn.SetReadLimit(linkMaxMessageBytes)
	return conn, nil
}

// dialWebSocket dials a manager: TLS handshake (pinning the practitioner
// cert via verify), then WS upgrade with the required subprotocol.
func dialWebSocket(ctx context.Context, endpoint string, presented tls.Certificate, verify func([][]byte, [][]*x509.Certificate) error) (*websocket.Conn, error) {
	tlsCfg := clientTLSConfig(presented, verify)
	dialCtx, cancel := context.WithTimeout(ctx, linkHandshakeTimeout)
	defer cancel()
	conn, _, err := websocket.Dial(dialCtx, "wss://"+endpoint, &websocket.DialOptions{
		Subprotocols: []string{linkSubprotocol},
		HTTPClient: &http.Client{
			Transport: &http.Transport{
				TLSClientConfig:     tlsCfg,
				TLSHandshakeTimeout: linkHandshakeTimeout,
			},
		},
	})
	if err != nil {
		return nil, err
	}
	if conn.Subprotocol() != linkSubprotocol {
		conn.Close(websocket.StatusProtocolError, "subprotocol mismatch")
		return nil, fmt.Errorf("manager did not negotiate %q (got %q)", linkSubprotocol, conn.Subprotocol())
	}
	conn.SetReadLimit(linkMaxMessageBytes)
	return conn, nil
}

// readFrame reads one JSON frame and returns its header + the raw bytes.
// Caller controls ctx for per-read deadlines.
func readFrame(ctx context.Context, conn *websocket.Conn) (frameHeader, []byte, error) {
	typ, data, err := conn.Read(ctx)
	if err != nil {
		return frameHeader{}, nil, err
	}
	if typ != websocket.MessageText {
		return frameHeader{}, nil, fmt.Errorf("non-text frame: %v", typ)
	}
	var h frameHeader
	if err := json.Unmarshal(data, &h); err != nil {
		return frameHeader{}, nil, fmt.Errorf("decode frame header: %w", err)
	}
	if h.PV != protocolVersion {
		return frameHeader{}, nil, fmt.Errorf("protocol version %d, want %d", h.PV, protocolVersion)
	}
	if h.Type == "" {
		return frameHeader{}, nil, errors.New("frame missing type")
	}
	return h, data, nil
}

// writeFrame marshals msg as JSON and writes it. msg should already
// contain "type"; pv is filled in here. Use this when you have arbitrary
// verb-specific fields; for a fixed shape, marshal yourself and call
// conn.Write directly.
func writeFrame(ctx context.Context, conn *websocket.Conn, msg map[string]any) error {
	msg["pv"] = protocolVersion
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("encode frame: %w", err)
	}
	return conn.Write(ctx, websocket.MessageText, data)
}

// peerFingerprintFromTLS extracts the SHA-256 hex fingerprint of the peer's
// leaf cert from an *http.Request's TLS state. Empty string if no peer
// cert is present (caller should treat that as an error).
func peerFingerprintFromTLS(r *http.Request) string {
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
		return ""
	}
	return fingerprintHex(r.TLS.PeerCertificates[0].Raw)
}
