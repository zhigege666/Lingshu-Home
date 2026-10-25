package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zhigege666/Lingshu-Home/server/internal/home"
)

func testServerTLSFiles(t *testing.T) (home.Config, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: "Home TLS test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true, IsCA: true,
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	config := home.Config{TLSCertFile: filepath.Join(directory, "cert.pem"), TLSKeyFile: filepath.Join(directory, "key.pem")}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(config.TLSCertFile, certPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.TLSKeyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(certPEM) {
		t.Fatal("could not trust fixture certificate")
	}
	return config, roots
}

func TestInvalidTLSFailsBeforeOpeningApplication(t *testing.T) {
	valid, _ := testServerTLSFiles(t)
	unrelated, _ := testServerTLSFiles(t)
	for _, test := range []struct{ name, cert, key string }{
		{"missing files", filepath.Join(t.TempDir(), "missing-cert.pem"), filepath.Join(t.TempDir(), "missing-key.pem")},
		{"mismatched pair", valid.TLSCertFile, unrelated.TLSKeyFile},
		{"malformed certificate", valid.TLSKeyFile, valid.TLSKeyFile},
	} {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			dataDir := filepath.Join(directory, "data-must-not-be-created")
			versionFile := filepath.Join(directory, "VERSION")
			if err := os.WriteFile(versionFile, []byte("0.1.0-test\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			occupied := testHTTPListener(t)
			t.Setenv("LINGSHU_SECURE_COOKIES", "false")
			// A valid application configuration would create the data directory.
			// The occupied port makes an accidental HTTP fallback fail promptly
			// rather than hanging this test waiting for an external signal.
			code := run([]string{"--tls-cert-file", test.cert, "--tls-key-file", test.key,
				"--data-dir", dataDir, "--version-file", versionFile,
				"--storage-provider", "sqlite", "--language", "en", "--listen", occupied.Addr().String()})
			if code != 1 {
				t.Fatalf("invalid TLS startup exit code=%d; want 1", code)
			}
			if _, err := os.Stat(dataDir); !os.IsNotExist(err) {
				t.Fatalf("invalid TLS must not initialize application data: %v", err)
			}
			if config, err := loadServerTLS(home.Config{TLSCertFile: test.cert, TLSKeyFile: test.key}); err == nil || config != nil {
				t.Fatalf("invalid TLS returned a usable/fallback configuration: %v %v", config, err)
			}
		})
	}
	if config, err := loadServerTLS(home.Config{}); err != nil || config != nil {
		t.Fatalf("unconfigured TLS must preserve HTTP mode: %v %v", config, err)
	}
}

func TestDirectTLSNegotiationCertificateVerificationAndNoPlaintextFallback(t *testing.T) {
	config, roots := testServerTLSFiles(t)
	tlsConfig, err := loadServerTLS(config)
	if err != nil {
		t.Fatal(err)
	}
	listener := testHTTPListener(t)
	var requests atomic.Int32
	server := &http.Server{TLSConfig: tlsConfig, ErrorLog: log.New(io.Discard, "", 0), Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.TLS == nil {
			t.Error("plaintext request reached the application")
			http.Error(w, "missing TLS", http.StatusInternalServerError)
			return
		}
		_, _ = io.WriteString(w, "encrypted application response")
	})}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- serveHTTP(ctx, server, func() error { return server.ServeTLS(listener, "", "") }, time.Second)
	}()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	})
	address := listener.Addr().String()
	for _, version := range []uint16{tls.VersionTLS12, tls.VersionTLS13} {
		transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: version, MaxVersion: version}}
		client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
		response, err := client.Get("https://" + address)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		transport.CloseIdleConnections()
		if err != nil || response.StatusCode != http.StatusOK || string(body) != "encrypted application response" || response.TLS == nil || response.TLS.Version != version {
			t.Fatalf("TLS %x request failed: status=%d body=%q error=%v", version, response.StatusCode, body, err)
		}
	}
	for _, clientConfig := range []*tls.Config{
		{RootCAs: roots, MinVersion: tls.VersionTLS10, MaxVersion: tls.VersionTLS10},
		{RootCAs: roots, MinVersion: tls.VersionTLS11, MaxVersion: tls.VersionTLS11},
		{RootCAs: x509.NewCertPool(), MinVersion: tls.VersionTLS12},
		{RootCAs: roots, ServerName: "wrong-host.example", MinVersion: tls.VersionTLS12},
	} {
		connection, err := tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", address, clientConfig)
		if connection != nil {
			_ = connection.Close()
		}
		if err == nil {
			t.Fatalf("legacy TLS or invalid server identity accepted: %+v", clientConfig)
		}
	}
	response, err := testHTTPClient(t).Get("http://" + address)
	if err == nil {
		_ = response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("plain HTTP unexpectedly returned status %d", response.StatusCode)
		}
	}
	if requests.Load() != 2 {
		t.Fatalf("failed TLS/plaintext request reached application; handler calls=%d", requests.Load())
	}
}
