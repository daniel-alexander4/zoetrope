package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"
)

const practitionerIdentityFilename = "practitioner_identity.pem"

// practitionerIdentity is the long-lived mTLS identity the manager
// presents when hosting sessions. Generated on first entry into manager
// mode, persisted alongside config.json, never auto-regenerated on load
// failure — regeneration would silently change the fingerprint and
// invalidate every URL the practitioner has ever shared.
type practitionerIdentity struct {
	Cert        *x509.Certificate
	CertDER     []byte
	PrivateKey  ed25519.PrivateKey
	Fingerprint string // SHA-256 of CertDER, lowercase hex
}

// sessionIdentity is a short-lived mTLS identity for one client session.
// The manager generates it, ships it in the session URL, and stores the
// cert pubkey as the session key.
type sessionIdentity struct {
	Cert       *x509.Certificate
	CertDER    []byte
	PrivateKey ed25519.PrivateKey
}

func (id *practitionerIdentity) tlsCertificate() tls.Certificate {
	return tls.Certificate{
		Certificate: [][]byte{id.CertDER},
		PrivateKey:  id.PrivateKey,
		Leaf:        id.Cert,
	}
}

func (id *sessionIdentity) tlsCertificate() tls.Certificate {
	return tls.Certificate{
		Certificate: [][]byte{id.CertDER},
		PrivateKey:  id.PrivateKey,
		Leaf:        id.Cert,
	}
}

func (id *sessionIdentity) fingerprint() string {
	return fingerprintHex(id.CertDER)
}

// practitionerIdentityPath returns the canonical location for the
// persistent practitioner cert+key, alongside config.json.
func practitionerIdentityPath(app string) (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, app, practitionerIdentityFilename), nil
}

// loadOrCreatePractitionerIdentity reads the cert+key from path, generating
// and persisting one if absent. Returns an error (without auto-regenerating)
// if the file exists but cannot be parsed or has expired.
func loadOrCreatePractitionerIdentity(path string) (*practitionerIdentity, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		id, gerr := generatePractitionerIdentity()
		if gerr != nil {
			return nil, gerr
		}
		if werr := writePractitionerIdentity(path, id); werr != nil {
			return nil, werr
		}
		return id, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return parsePractitionerIdentity(data, path)
}

func generatePractitionerIdentity() (*practitionerIdentity, error) {
	cert, der, priv, err := createSelfSignedEd25519Cert(
		"zoetrope-practitioner",
		time.Now().UTC().AddDate(10, 0, 0),
	)
	if err != nil {
		return nil, err
	}
	return &practitionerIdentity{
		Cert:        cert,
		CertDER:     der,
		PrivateKey:  priv,
		Fingerprint: fingerprintHex(der),
	}, nil
}

func generateSessionIdentity() (*sessionIdentity, error) {
	cert, der, priv, err := createSelfSignedEd25519Cert(
		"zoetrope-session",
		time.Now().UTC().Add(24*time.Hour),
	)
	if err != nil {
		return nil, err
	}
	return &sessionIdentity{Cert: cert, CertDER: der, PrivateKey: priv}, nil
}

func createSelfSignedEd25519Cert(commonName string, notAfter time.Time) (*x509.Certificate, []byte, ed25519.PrivateKey, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("generate ed25519 key: %w", err)
	}
	// 128-bit crypto-random serial. Some TLS stacks reject zero-or-one.
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("serial: %w", err)
	}
	now := time.Now().UTC()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: commonName},
		NotBefore:    now.Add(-5 * time.Minute), // back-date for client clock skew
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, pub, priv)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("create cert: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("parse cert: %w", err)
	}
	return cert, der, priv, nil
}

func parsePractitionerIdentity(data []byte, path string) (*practitionerIdentity, error) {
	var certDER, keyDER []byte
	for {
		var block *pem.Block
		block, data = pem.Decode(data)
		if block == nil {
			break
		}
		switch block.Type {
		case "CERTIFICATE":
			if certDER != nil {
				return nil, fmt.Errorf("%s: multiple CERTIFICATE blocks", path)
			}
			certDER = block.Bytes
		case "PRIVATE KEY":
			if keyDER != nil {
				return nil, fmt.Errorf("%s: multiple PRIVATE KEY blocks", path)
			}
			keyDER = block.Bytes
		}
	}
	if certDER == nil || keyDER == nil {
		return nil, fmt.Errorf("%s: missing CERTIFICATE or PRIVATE KEY block", path)
	}
	cert, err := x509.ParseCertificate(certDER)
	if err != nil {
		return nil, fmt.Errorf("%s: parse cert: %w", path, err)
	}
	keyAny, err := x509.ParsePKCS8PrivateKey(keyDER)
	if err != nil {
		return nil, fmt.Errorf("%s: parse key: %w", path, err)
	}
	priv, ok := keyAny.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s: key is %T, want ed25519.PrivateKey", path, keyAny)
	}
	if time.Now().After(cert.NotAfter) {
		return nil, fmt.Errorf("practitioner identity expired %s — delete %s and re-enter manager mode to regenerate",
			cert.NotAfter.Format(time.RFC3339), path)
	}
	return &practitionerIdentity{
		Cert:        cert,
		CertDER:     certDER,
		PrivateKey:  priv,
		Fingerprint: fingerprintHex(certDER),
	}, nil
}

// writePractitionerIdentity writes cert+key as a two-block PEM bundle
// using the same atomic temp-file + rename pattern as configStore.save,
// with file mode 0600.
func writePractitionerIdentity(path string, id *practitionerIdentity) error {
	keyDER, err := x509.MarshalPKCS8PrivateKey(id.PrivateKey)
	if err != nil {
		return fmt.Errorf("marshal key: %w", err)
	}
	var buf []byte
	buf = append(buf, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: id.CertDER})...)
	buf = append(buf, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})...)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".practitioner.*.tmp")
	if err != nil {
		return fmt.Errorf("create tmp: %w", err)
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(buf); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write tmp: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("chmod tmp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close tmp: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

func fingerprintHex(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}
