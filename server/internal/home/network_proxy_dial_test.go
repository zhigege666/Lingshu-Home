package home

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"
)

func proxyTestRuntime(t *testing.T, endpoint string, secret networkProxySecret) *networkProxyRuntime {
	t.Helper()
	u, err := networkProxyURL(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	mode := "proxy"
	if u == nil {
		mode = "direct"
	}
	return &networkProxyRuntime{revision: 1, config: NetworkProxyConfig{Revision: "1", Mode: mode, URL: endpoint, CredentialConfigured: secret.Username != ""}, endpoint: u, secret: secret}
}

// A complete proxy TCP connection without any external sockets or DNS. The
// server always has a deadline, including malformed-protocol failure cases.
func proxyTestPipe(t *testing.T, serve func(net.Conn) error) (iconDialContext, <-chan error) {
	t.Helper()
	result := make(chan error, 4)
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		client, server := net.Pipe()
		_ = server.SetDeadline(time.Now().Add(3 * time.Second))
		t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
		// Keep a successful tunnel open until the client/cleanup closes it.
		// Closing immediately after writing CONNECT's header can race with the
		// client's SetDeadline reset and turn a valid handshake into EPIPE.
		go func() { result <- serve(server) }()
		return client, nil
	}
	return dial, result
}

func proxyTestResult(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("local proxy fixture did not complete")
	}
}

func TestNetworkProxyHTTPConnect(t *testing.T) {
	for _, scheme := range []string{"http"} {
		t.Run(scheme+"-bounded-header-and-buffered-tunnel", func(t *testing.T) {
			secret := networkProxySecret{Username: "fixture-user", Password: "fixture-password"}
			dial, done := proxyTestPipe(t, func(conn net.Conn) error {
				r, err := http.ReadRequest(bufio.NewReader(conn))
				if err != nil {
					return err
				}
				if r.Method != "CONNECT" || r.RequestURI != "8.8.8.8:80" || r.Host != "8.8.8.8:80" || r.Header.Get("Proxy-Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte(secret.Username+":"+secret.Password)) || r.Header.Get("Authorization") != "" {
					return errors.New("CONNECT did not contain only the literal target and proxy authentication")
				}
				// Per RFC 9110, a 2xx CONNECT has no HTTP message body. These
				// deliberately misleading length headers must not eat tunnel data.
				return writeNetworkProxyBytes(conn, []byte("HTTP/1.1 200 Connection established\r\nContent-Length: 9999\r\nTransfer-Encoding: chunked\r\n\r\nTUNNEL"))
			})
			var sockets []string
			options := networkProxyDialOptions{resolver: &iconTestResolver{ips: []netip.Addr{netip.MustParseAddr("127.0.0.1")}}, dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				sockets = append(sockets, address)
				return dial(ctx, network, address)
			}}
			conn, err := dialNetworkProxyTarget(context.Background(), "tcp", "8.8.8.8:80", proxyTestRuntime(t, "http://proxy.example.org:3128", secret), options)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			payload := make([]byte, 6)
			if _, err := io.ReadFull(conn, payload); err != nil || string(payload) != "TUNNEL" {
				t.Fatal("CONNECT lost buffered tunnel bytes", err)
			}
			if len(sockets) != 1 || sockets[0] != "127.0.0.1:3128" {
				t.Fatal("proxy dial contacted a destination directly")
			}
			proxyTestResult(t, done)
		})
	}
	for name, response := range map[string]string{
		"authentication":    "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
		"redirect":          "HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/\r\n\r\n",
		"refused-http-port": "HTTP/1.1 403 Forbidden\r\n\r\n",
		"bad-version":       "HTTP/2 200 OK\r\n\r\n",
		"bad-status":        "HTTP/1.1 xxx OK\r\n\r\n",
		"bad-header":        "HTTP/1.1 200 OK\r\ninvalid-header\r\n\r\n",
		"excessive-header":  "HTTP/1.1 200 OK\r\nX-Large: " + strings.Repeat("a", networkProxyMaxHeader) + "\r\n\r\n",
		"truncated":         "HTTP/1.1 200 OK\r\n",
	} {
		t.Run(name, func(t *testing.T) {
			dial, _ := proxyTestPipe(t, func(conn net.Conn) error {
				if _, err := http.ReadRequest(bufio.NewReader(conn)); err != nil {
					return err
				}
				err := writeNetworkProxyBytes(conn, []byte(response))
				if name == "truncated" {
					_ = conn.Close()
				}
				return err
			})
			var sockets []string
			options := networkProxyDialOptions{resolver: &iconTestResolver{ips: []netip.Addr{netip.MustParseAddr("127.0.0.1"), netip.MustParseAddr("127.0.0.2")}}, dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				sockets = append(sockets, address)
				return dial(ctx, network, address)
			}}
			conn, err := dialNetworkProxyTarget(context.Background(), "tcp", "8.8.8.8:80", proxyTestRuntime(t, "http://proxy.example.org:3128", networkProxySecret{}), options)
			if err == nil || conn != nil {
				if conn != nil {
					_ = conn.Close()
				}
				t.Fatal("invalid CONNECT response was accepted")
			}
			if len(sockets) != 1 || sockets[0] != "127.0.0.1:3128" {
				t.Fatal("proxy refusal selected another proxy or a direct fallback")
			}
			if name == "refused-http-port" && !strings.Contains(err.Error(), "port 80") {
				t.Fatal("CONNECT port policy failure omitted actionable constraint")
			}
		})
	}
}

func TestNetworkProxySOCKS5LiteralTargets(t *testing.T) {
	for _, fixture := range []struct {
		name, target string
		secret       networkProxySecret
		atyp         byte
	}{
		{"ipv4-noauth", "8.8.8.8:80", networkProxySecret{}, 1},
		{"ipv4-password", "1.1.1.1:443", networkProxySecret{Username: "fixture-user", Password: "fixture-password"}, 1},
		{"ipv6-password", "[2606:4700:4700::1111]:8443", networkProxySecret{Username: "fixture-user", Password: "fixture-password"}, 4},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			dial, done := proxyTestPipe(t, func(conn net.Conn) error {
				greeting := make([]byte, 3)
				if _, err := io.ReadFull(conn, greeting); err != nil {
					return err
				}
				method := byte(0)
				if fixture.secret.Username != "" {
					method = 2
				}
				if !bytes.Equal(greeting, []byte{5, 1, method}) {
					return errors.New("SOCKS5 offered an unconfigured authentication fallback")
				}
				if err := writeNetworkProxyBytes(conn, []byte{5, method}); err != nil {
					return err
				}
				if method == 2 {
					var head [2]byte
					if _, err := io.ReadFull(conn, head[:]); err != nil || head[0] != 1 {
						return errors.New("invalid SOCKS5 credential frame")
					}
					user := make([]byte, int(head[1]))
					if _, err := io.ReadFull(conn, user); err != nil {
						return err
					}
					if _, err := io.ReadFull(conn, head[:1]); err != nil {
						return err
					}
					password := make([]byte, int(head[0]))
					if _, err := io.ReadFull(conn, password); err != nil {
						return err
					}
					if string(user) != fixture.secret.Username || string(password) != fixture.secret.Password {
						return errors.New("SOCKS5 credential pair was corrupted")
					}
					if err := writeNetworkProxyBytes(conn, []byte{1, 0}); err != nil {
						return err
					}
				}
				var head [4]byte
				if _, err := io.ReadFull(conn, head[:]); err != nil {
					return err
				}
				if !bytes.Equal(head[:], []byte{5, 1, 0, fixture.atyp}) {
					return errors.New("SOCKS5 delegated a target hostname or used a non-CONNECT command")
				}
				length := 4
				if fixture.atyp == 4 {
					length = 16
				}
				address := make([]byte, length+2)
				if _, err := io.ReadFull(conn, address); err != nil {
					return err
				}
				ip, ok := netip.AddrFromSlice(address[:length])
				got := net.JoinHostPort(ip.String(), fmt.Sprint(binary.BigEndian.Uint16(address[length:])))
				if !ok || got != fixture.target {
					return errors.New("SOCKS5 did not receive the pinned literal destination")
				}
				// BND.ADDR can be a domain in the response. It is bounded metadata
				// only and must not cause a lookup, redirect or target change.
				return writeNetworkProxyBytes(conn, append([]byte{5, 0, 0, 3, 7, 'i', 'g', 'n', 'o', 'r', 'e', 'd', 0, 0}, []byte("OK")...))
			})
			resolver := &iconTestResolver{ips: []netip.Addr{netip.MustParseAddr("127.0.0.1")}}
			conn, err := dialNetworkProxyTarget(context.Background(), "tcp", fixture.target, proxyTestRuntime(t, "socks5://proxy.example.org:1080", fixture.secret), networkProxyDialOptions{resolver: resolver, dial: dial})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			var payload [2]byte
			if _, err := io.ReadFull(conn, payload[:]); err != nil || string(payload[:]) != "OK" || resolver.calls != 1 {
				t.Fatal("SOCKS5 tunnel metadata changed route or lost bytes", err)
			}
			proxyTestResult(t, done)
		})
	}
	for _, selected := range []byte{0, 1, 255} {
		t.Run(fmt.Sprintf("reject-method-%d", selected), func(t *testing.T) {
			dial, done := proxyTestPipe(t, func(conn net.Conn) error {
				var greeting [3]byte
				if _, err := io.ReadFull(conn, greeting[:]); err != nil {
					return err
				}
				return writeNetworkProxyBytes(conn, []byte{5, selected})
			})
			conn, err := dialNetworkProxyTarget(context.Background(), "tcp", "8.8.8.8:443", proxyTestRuntime(t, "socks5://127.0.0.1:1080", networkProxySecret{Username: "u", Password: "p"}), networkProxyDialOptions{dial: dial})
			if err == nil || conn != nil {
				if conn != nil {
					_ = conn.Close()
				}
				t.Fatal("SOCKS5 silently downgraded authentication")
			}
			proxyTestResult(t, done)
		})
	}
}

func TestNetworkProxyTargetsRemainPinnedAndFiltered(t *testing.T) {
	runtime := proxyTestRuntime(t, "http://proxy.example.org:3128", networkProxySecret{})
	for _, target := range []string{"127.0.0.1:80", "[::1]:443", "169.254.169.254:80", "100.100.100.200:80", "[fd00:ec2::254]:80", "198.18.0.1:80", "192.0.2.1:80", "unresolved.example.org:443"} {
		dialed := false
		_, err := dialNetworkProxyTarget(context.Background(), "tcp", target, runtime, networkProxyDialOptions{dial: func(context.Context, string, string) (net.Conn, error) {
			dialed = true
			return nil, errors.New("unexpected dial")
		}})
		if err == nil || dialed {
			t.Errorf("unsafe final target contacted a proxy: %s", target)
		}
	}
	for _, private := range []bool{false, true} {
		for _, targetIPs := range [][]netip.Addr{
			{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("169.254.169.254")},
			{netip.MustParseAddr("127.0.0.1")},
			{netip.MustParseAddr("fd00:ec2::254")},
		} {
			dialed := false
			pinned := integrationPinnedDial(&iconTestResolver{ips: targetIPs}, func(context.Context, string, string) (net.Conn, error) {
				dialed = true
				return nil, errors.New("unexpected dial")
			}, private)
			if _, err := pinned(context.Background(), "tcp", "source.example.org:443"); err == nil || dialed {
				t.Fatal("mixed/unsafe source DNS reached an outbound proxy", private)
			}
		}
	}
	for _, private := range []bool{false, true} {
		var target string
		pinned := integrationPinnedDial(&iconTestResolver{ips: []netip.Addr{netip.MustParseAddr("10.2.3.4")}}, func(ctx context.Context, network, address string) (net.Conn, error) {
			target = address
			return nil, errors.New("fixture stops before socket")
		}, private)
		_, _ = pinned(context.Background(), "tcp", "source.example.org:8080")
		if (!private && target != "") || (private && target != "10.2.3.4:8080") {
			t.Fatal("source private-network permission was broadened or lost before proxy", private)
		}
	}
	for _, ips := range [][]netip.Addr{
		{netip.MustParseAddr("127.0.0.1"), netip.MustParseAddr("169.254.169.254")},
		{netip.MustParseAddr("fd00:ec2::254")},
		{netip.MustParseAddr("100.100.100.200")},
		nil,
	} {
		dialed := false
		_, err := dialNetworkProxyTarget(context.Background(), "tcp", "8.8.8.8:443", runtime, networkProxyDialOptions{resolver: &iconTestResolver{ips: ips}, dial: func(context.Context, string, string) (net.Conn, error) {
			dialed = true
			return nil, errors.New("unexpected dial")
		}})
		if err == nil || dialed {
			t.Fatal("unsafe/mixed proxy DNS was partially dialed")
		}
	}
	var attempts []string
	_, err := dialNetworkProxyTarget(context.Background(), "tcp", "8.8.8.8:443", runtime, networkProxyDialOptions{resolver: &iconTestResolver{ips: []netip.Addr{netip.MustParseAddr("127.0.0.1"), netip.MustParseAddr("10.2.3.4")}}, dial: func(_ context.Context, _, address string) (net.Conn, error) {
		attempts = append(attempts, address)
		return nil, errors.New("fixture connection failure")
	}})
	if err == nil || len(attempts) != 2 || attempts[0] != "127.0.0.1:3128" || attempts[1] != "10.2.3.4:3128" {
		t.Fatal("unreachable proxies caused a direct destination fallback")
	}
	if !strings.Contains(err.Error(), "direct fallback is disabled") {
		t.Fatal("proxy failure did not explain its fail-closed behavior")
	}
}

func TestNetworkProxyClientsIgnoreEnvironmentAndKeepPolicies(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://169.254.169.254:80")
	t.Setenv("HTTPS_PROXY", "http://169.254.169.254:80")
	t.Setenv("ALL_PROXY", "socks5://169.254.169.254:80")
	a := &App{}
	for _, client := range []*http.Client{a.newOutboundIconHTTPClient(), a.newOutboundIntegrationHTTPClient(false), a.newOutboundIntegrationHTTPClient(true), a.newOutboundGitHubClient()} {
		transport, ok := client.Transport.(*http.Transport)
		if !ok || transport.Proxy != nil || transport.DialContext == nil || !transport.DisableKeepAlives || !transport.DisableCompression || transport.TLSHandshakeTimeout <= 0 || transport.MaxResponseHeaderBytes != 32<<10 || client.Timeout <= 0 {
			t.Fatal("outbound adapter inherited environmental proxy or lost bounded transport policy")
		}
		if client.CheckRedirect == nil || client.CheckRedirect(&http.Request{}, nil) != http.ErrUseLastResponse {
			t.Fatal("outbound adapter silently followed redirects")
		}
		if transport.TLSClientConfig != nil && transport.TLSClientConfig.InsecureSkipVerify {
			t.Fatal("outbound adapter disabled target certificate verification")
		}
	}
	var dialed string
	_, err := dialNetworkProxyTarget(context.Background(), "tcp", "8.8.8.8:443", proxyTestRuntime(t, "", networkProxySecret{}), networkProxyDialOptions{dial: func(_ context.Context, _, address string) (net.Conn, error) {
		dialed = address
		return nil, errors.New("offline fixture")
	}})
	if err == nil || dialed != "8.8.8.8:443" {
		t.Fatal("direct mode inherited a process proxy variable")
	}
}

func proxyTestCertificate(t *testing.T, hostname string) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: hostname}, DNSNames: []string{hostname}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, pool
}

func TestNetworkProxyHTTPSAndDestinationTLSIdentity(t *testing.T) {
	proxyCert, proxyRoots := proxyTestCertificate(t, "proxy.example.org")
	targetCert, targetRoots := proxyTestCertificate(t, "target.example.org")
	for _, fixture := range []struct {
		name       string
		roots      *x509.CertPool
		targetPool *x509.CertPool
		success    bool
	}{
		{"both-identities-verified", proxyRoots, targetRoots, true},
		{"untrusted-proxy-rejected", x509.NewCertPool(), targetRoots, false},
		{"untrusted-target-rejected", proxyRoots, x509.NewCertPool(), false},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			var mu sync.Mutex
			var proxySNI, targetSNI, authority, targetHost string
			secret := networkProxySecret{Username: "fixture-user", Password: "fixture-password"}
			dial, done := proxyTestPipe(t, func(raw net.Conn) error {
				proxyConn := tls.Server(raw, &tls.Config{Certificates: []tls.Certificate{proxyCert}, MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}, GetConfigForClient: func(info *tls.ClientHelloInfo) (*tls.Config, error) {
					mu.Lock()
					proxySNI = info.ServerName
					mu.Unlock()
					return nil, nil
				}})
				if err := proxyConn.Handshake(); err != nil {
					return err
				}
				reader := bufio.NewReader(proxyConn)
				connect, err := http.ReadRequest(reader)
				if err != nil {
					return err
				}
				mu.Lock()
				authority = connect.RequestURI
				mu.Unlock()
				if connect.Method != "CONNECT" || connect.Header.Get("Proxy-Authorization") == "" {
					return errors.New("HTTPS proxy did not receive the CONNECT authentication")
				}
				if err := writeNetworkProxyBytes(proxyConn, []byte("HTTP/1.1 200 OK\r\n\r\n")); err != nil {
					return err
				}
				targetConn := tls.Server(&networkProxyBufferedConn{Conn: proxyConn, reader: reader}, &tls.Config{Certificates: []tls.Certificate{targetCert}, MinVersion: tls.VersionTLS12, GetConfigForClient: func(info *tls.ClientHelloInfo) (*tls.Config, error) {
					mu.Lock()
					targetSNI = info.ServerName
					mu.Unlock()
					return nil, nil
				}})
				if err := targetConn.Handshake(); err != nil {
					return err
				}
				request, err := http.ReadRequest(bufio.NewReader(targetConn))
				if err != nil {
					return err
				}
				mu.Lock()
				targetHost = request.Host
				mu.Unlock()
				if request.Header.Get("Proxy-Authorization") != "" || request.Header.Get("Authorization") != "Bearer source-fixture" || request.RequestURI != "/data" {
					return errors.New("proxy authentication leaked into destination HTTP request or source headers changed")
				}
				return writeNetworkProxyBytes(targetConn, []byte("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"))
			})
			runtime := proxyTestRuntime(t, "https://proxy.example.org:8443", secret)
			proxyDial := func(ctx context.Context, network, address string) (net.Conn, error) {
				return dialNetworkProxyTarget(ctx, network, address, runtime, networkProxyDialOptions{resolver: &iconTestResolver{ips: []netip.Addr{netip.MustParseAddr("127.0.0.1")}}, dial: dial, proxyRoots: fixture.roots})
			}
			client := newIconHTTPClientWithDial(proxyDial)
			transport := client.Transport.(*http.Transport)
			transport.DialContext = iconPinnedDial(&iconTestResolver{ips: []netip.Addr{netip.MustParseAddr("8.8.8.8")}}, proxyDial)
			transport.TLSClientConfig = &tls.Config{RootCAs: fixture.targetPool, MinVersion: tls.VersionTLS12}
			request, err := http.NewRequest("GET", "https://target.example.org/data", nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer source-fixture")
			response, err := client.Do(request)
			if !fixture.success {
				if err == nil {
					_ = response.Body.Close()
					t.Fatal("TLS verification accepted an untrusted proxy or target")
				}
				return
			}
			if err != nil {
				t.Fatal("verified proxy and destination tunnel failed", err)
			}
			body, err := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err != nil || string(body) != "{}" {
				t.Fatal("nested TLS tunnel corrupted destination data", err)
			}
			proxyTestResult(t, done)
			mu.Lock()
			defer mu.Unlock()
			if proxySNI != "proxy.example.org" || targetSNI != "target.example.org" || authority != "8.8.8.8:443" || targetHost != "target.example.org" {
				t.Fatal("proxy routing replaced a TLS identity or delegated target DNS")
			}
		})
	}
}

func TestNetworkProxyHandshakeCancellation(t *testing.T) {
	started := make(chan struct{})
	dial, _ := proxyTestPipe(t, func(conn net.Conn) error {
		if _, err := http.ReadRequest(bufio.NewReader(conn)); err != nil {
			return err
		}
		close(started)
		var b [1]byte
		_, err := conn.Read(b[:])
		return err
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	runtime := proxyTestRuntime(t, "http://127.0.0.1:3128", networkProxySecret{})
	go func() {
		conn, err := dialNetworkProxyTarget(ctx, "tcp", "8.8.8.8:443", runtime, networkProxyDialOptions{dial: dial})
		if conn != nil {
			_ = conn.Close()
		}
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("local CONNECT fixture did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled CONNECT completed successfully")
		}
	case <-time.After(time.Second):
		t.Fatal("context cancellation failed to interrupt proxy handshake")
	}
}

type proxyBlockingResolver struct{ started chan struct{} }

func (r *proxyBlockingResolver) LookupNetIP(ctx context.Context, _, _ string) ([]netip.Addr, error) {
	close(r.started)
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestNetworkProxyGenerationCancelsDetachedDNSAndOpenTunnel(t *testing.T) {
	generation, invalidate := context.WithCancelCause(context.Background())
	defer invalidate(context.Canceled)
	ctx := context.WithValue(context.Background(), networkProxyOperationKey{}, networkProxyOperation{runtime: proxyTestRuntime(t, "", networkProxySecret{}), generation: generation})
	ctx = context.WithoutCancel(ctx)
	resolver := &proxyBlockingResolver{started: make(chan struct{})}
	dial := networkProxyGenerationDial(iconPinnedDial(resolver, func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("DNS cancellation must happen before any socket")
	}))
	done := make(chan error, 1)
	go func() {
		conn, err := dial(ctx, "tcp", "target.example.org:443")
		if conn != nil {
			_ = conn.Close()
		}
		done <- err
	}()
	select {
	case <-resolver.started:
	case <-time.After(time.Second):
		t.Fatal("fixture destination DNS did not start")
	}
	client, server := net.Pipe()
	defer server.Close()
	conn, err := networkProxyConnection(generation, client)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	socketClosed := make(chan error, 1)
	go func() { var b [1]byte; _, err := server.Read(b[:]); socketClosed <- err }()
	invalidate(errNetworkProxyChanged)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("detached destination DNS completed after generation change")
		}
	case <-time.After(time.Second):
		t.Fatal("generation did not cancel detached destination DNS")
	}
	select {
	case err := <-socketClosed:
		if err == nil {
			t.Fatal("invalidated tunnel remained readable")
		}
	case <-time.After(time.Second):
		t.Fatal("generation did not close established proxy tunnel")
	}
}
