package home

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

const networkProxyHandshakeTimeout = 4 * time.Second
const networkProxyMaxHeader = 8 << 10

// Only the Owner can choose this endpoint. Local forward proxies are useful,
// so loopback/RFC1918/ULA are allowed here; destination policy is separately
// enforced before a tunnel is requested and cannot inherit this exception.
func networkProxyAddressAllowed(ip netip.Addr) bool {
	if !ip.IsValid() || ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	if ip == netip.MustParseAddr("fd00:ec2::254") || ip == netip.MustParseAddr("100.100.100.200") {
		return false
	}
	return iconPublicIP(ip) || ip.IsLoopback() || ip.IsPrivate() && ip.IsGlobalUnicast() && !ip.IsLinkLocalUnicast()
}

type networkProxyDialOptions struct {
	resolver iconIPResolver
	dial     iconDialContext
	// Internal fixture injection only. Production always uses system roots and
	// verifies the configured proxy hostname; no insecure-TLS option is exposed.
	proxyRoots *x509.CertPool
}

func defaultNetworkProxyDialOptions() networkProxyDialOptions {
	dialer := &net.Dialer{Timeout: networkProxyHandshakeTimeout, KeepAlive: -1}
	return networkProxyDialOptions{resolver: net.DefaultResolver, dial: dialer.DialContext}
}

func (a *App) dialNetworkTarget(ctx context.Context, network, address string) (net.Conn, error) {
	operation, ok := ctx.Value(networkProxyOperationKey{}).(networkProxyOperation)
	if !ok {
		// An application proxy-capable client must capture the configuration for
		// its complete logical operation, including redirects and final storage.
		return nil, errors.New("outbound operation has no configuration snapshot")
	}
	// net/http may detach a pending dial from one request's cancellation while
	// keeping its context values. Link the dial to the captured generation
	// explicitly, so changing the proxy also interrupts DNS and handshakes.
	dialCtx, cancel := context.WithCancelCause(ctx)
	stop := context.AfterFunc(operation.generation, func() { cancel(context.Cause(operation.generation)) })
	defer func() { stop(); cancel(context.Canceled) }()
	if operation.generation.Err() != nil {
		cancel(context.Cause(operation.generation))
	}
	conn, err := dialNetworkProxyTarget(dialCtx, network, address, operation.runtime, defaultNetworkProxyDialOptions())
	if err != nil {
		return nil, err
	}
	return networkProxyConnection(operation.generation, conn)
}

type networkProxyLiveConn struct {
	net.Conn
	stop func() bool
}

func (c *networkProxyLiveConn) Close() error {
	c.stop()
	return c.Conn.Close()
}

// A successful dial can outlive net/http's detached pending-dial context, for
// example during destination TLS. Keep the socket tied to the chosen proxy
// generation until the HTTP client closes it; changing route cannot leave an
// old tunnel doing network I/O in the background.
func networkProxyConnection(generation context.Context, conn net.Conn) (net.Conn, error) {
	stop := context.AfterFunc(generation, func() { _ = conn.Close() })
	if err := generation.Err(); err != nil {
		stop()
		_ = conn.Close()
		return nil, err
	}
	return &networkProxyLiveConn{Conn: conn, stop: stop}, nil
}

// Wrap the entire policy dial, including the original destination DNS lookup.
// The inner tunnel adapter applies the same guard independently as a defense
// against accidental direct invocation without this transport wrapper.
func networkProxyGenerationDial(next iconDialContext) iconDialContext {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		operation, ok := ctx.Value(networkProxyOperationKey{}).(networkProxyOperation)
		if !ok {
			return nil, errors.New("outbound operation has no configuration snapshot")
		}
		linked, cancel := context.WithCancelCause(ctx)
		stop := context.AfterFunc(operation.generation, func() { cancel(context.Cause(operation.generation)) })
		defer func() { stop(); cancel(context.Canceled) }()
		if operation.generation.Err() != nil {
			cancel(context.Cause(operation.generation))
		}
		return next(linked, network, address)
	}
}

func dialNetworkProxyTarget(ctx context.Context, network, address string, runtime *networkProxyRuntime, options networkProxyDialOptions) (net.Conn, error) {
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, errors.New("unsupported outbound network")
	}
	host, port, err := net.SplitHostPort(address)
	ip, parseErr := netip.ParseAddr(host)
	portNumber, portErr := strconv.Atoi(port)
	if err != nil || parseErr != nil || ip.Zone() != "" || !integrationAllowedAddress(ip, true) || portErr != nil || portNumber < 1 || portNumber > 65535 {
		return nil, errors.New("outbound tunnel requires an already validated literal target")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	target := net.JoinHostPort(ip.Unmap().String(), strconv.Itoa(portNumber))
	if runtime == nil {
		return nil, errors.New("outbound configuration is unavailable")
	}
	if runtime.config.Mode == "direct" {
		conn, err := options.dial(ctx, "tcp", target)
		if err != nil {
			return nil, errors.New("direct outbound connection failed")
		}
		return conn, nil
	}
	if runtime.config.Mode != "proxy" || runtime.endpoint == nil {
		return nil, errors.New("outbound proxy configuration is invalid")
	}
	proxyHost, proxyPort := runtime.endpoint.Hostname(), runtime.endpoint.Port()
	var ips []netip.Addr
	if ip, err := netip.ParseAddr(proxyHost); err == nil {
		ips = []netip.Addr{ip}
	} else {
		ips, err = options.resolver.LookupNetIP(ctx, "ip", proxyHost)
		if err != nil {
			return nil, errors.New("proxy hostname lookup failed")
		}
	}
	if len(ips) < 1 || len(ips) > 16 {
		return nil, errors.New("proxy hostname lookup is empty or excessive")
	}
	for _, ip := range ips {
		if !networkProxyAddressAllowed(ip) {
			return nil, errors.New("proxy hostname resolves to a blocked address")
		}
	}
	for _, proxyIP := range ips {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// Both proxy and destination are pinned literals before making a socket.
		// There is no hostname delegated to the proxy and no direct fallback.
		conn, err := options.dial(ctx, "tcp", net.JoinHostPort(proxyIP.Unmap().String(), proxyPort))
		if err != nil {
			continue
		}
		tunnel, err := establishNetworkProxyTunnel(ctx, conn, target, runtime, options.proxyRoots)
		if err == nil {
			return tunnel, nil
		}
		_ = conn.Close()
		// A reachable proxy's refusal is final. In particular, an authentication
		// or CONNECT-port refusal cannot silently select another route.
		return nil, err
	}
	return nil, errors.New("outbound proxy connection failed; direct fallback is disabled")
}

func establishNetworkProxyTunnel(parent context.Context, raw net.Conn, target string, runtime *networkProxyRuntime, roots *x509.CertPool) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(parent, networkProxyHandshakeTimeout)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { _ = raw.Close() })
	defer stop()
	deadline, _ := ctx.Deadline()
	if err := raw.SetDeadline(deadline); err != nil {
		return nil, errors.New("proxy socket deadline failed")
	}
	conn := raw
	if runtime.endpoint.Scheme == "https" {
		secure := tls.Client(raw, &tls.Config{ServerName: runtime.endpoint.Hostname(), RootCAs: roots, MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}})
		if err := secure.HandshakeContext(ctx); err != nil {
			return nil, errors.New("HTTPS proxy certificate or TLS handshake failed")
		}
		conn = secure
	}
	var tunnel net.Conn
	var err error
	switch runtime.endpoint.Scheme {
	case "http", "https":
		tunnel, err = networkProxyConnect(conn, target, runtime.secret)
	case "socks5":
		tunnel, err = networkProxySOCKS5(conn, target, runtime.secret)
	default:
		err = errors.New("unsupported outbound proxy scheme")
	}
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil || !stop() {
		_ = raw.Close()
		return nil, errors.New("proxy tunnel was cancelled")
	}
	if err := tunnel.SetDeadline(time.Time{}); err != nil {
		_ = raw.Close()
		return nil, errors.New("proxy tunnel deadline reset failed")
	}
	return tunnel, nil
}

type networkProxyBufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *networkProxyBufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

// RFC 9110 section 9.3.6: after a successful CONNECT, bytes immediately after
// the header are tunnel bytes. Ignore Content-Length/Transfer-Encoding here;
// neither describes an HTTP response body on an established tunnel.
func networkProxyConnect(conn net.Conn, target string, secret networkProxySecret) (net.Conn, error) {
	var request strings.Builder
	fmt.Fprintf(&request, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n", target, target)
	if secret.Username != "" {
		encoded := base64.StdEncoding.EncodeToString([]byte(secret.Username + ":" + secret.Password))
		request.WriteString("Proxy-Authorization: Basic " + encoded + "\r\n")
	}
	request.WriteString("\r\n")
	if err := writeNetworkProxyBytes(conn, []byte(request.String())); err != nil {
		return nil, errors.New("HTTP proxy CONNECT write failed")
	}
	reader := bufio.NewReaderSize(conn, 4096)
	head := make([]byte, 0, 1024)
	for len(head) < networkProxyMaxHeader {
		ch, err := reader.ReadByte()
		if err != nil {
			return nil, errors.New("HTTP proxy CONNECT response was incomplete")
		}
		head = append(head, ch)
		if bytes.HasSuffix(head, []byte("\r\n\r\n")) {
			break
		}
	}
	if !bytes.HasSuffix(head, []byte("\r\n\r\n")) {
		return nil, errors.New("HTTP proxy CONNECT response headers exceeded the limit")
	}
	parser := textproto.NewReader(bufio.NewReader(bytes.NewReader(head)))
	status, err := parser.ReadLine()
	if err != nil {
		return nil, errors.New("HTTP proxy returned an invalid CONNECT response")
	}
	fields := strings.SplitN(status, " ", 3)
	if len(fields) < 2 || (fields[0] != "HTTP/1.0" && fields[0] != "HTTP/1.1") || len(fields[1]) != 3 {
		return nil, errors.New("HTTP proxy returned an invalid CONNECT status")
	}
	code, err := strconv.Atoi(fields[1])
	if err != nil {
		return nil, errors.New("HTTP proxy returned an invalid CONNECT status")
	}
	if _, err := parser.ReadMIMEHeader(); err != nil {
		return nil, errors.New("HTTP proxy returned invalid CONNECT headers")
	}
	if code == 407 {
		return nil, errors.New("HTTP proxy authentication was rejected")
	}
	if code < 200 || code >= 300 {
		return nil, errors.New("HTTP proxy CONNECT was refused; the proxy must permit the destination port, including port 80 for HTTP")
	}
	return &networkProxyBufferedConn{Conn: conn, reader: reader}, nil
}

func writeNetworkProxyBytes(w io.Writer, body []byte) error {
	for len(body) > 0 {
		n, err := w.Write(body)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		body = body[n:]
	}
	return nil
}

// This adapter intentionally implements only bounded TCP CONNECT with a
// validated IPv4/IPv6 literal, and optional RFC 1929 authentication. It has no
// remote-DNS, BIND, UDP, environment proxy or alternate authentication fallback.
func networkProxySOCKS5(conn net.Conn, target string, secret networkProxySecret) (net.Conn, error) {
	method := byte(0)
	if secret.Username != "" {
		method = 2
	}
	if err := writeNetworkProxyBytes(conn, []byte{5, 1, method}); err != nil {
		return nil, errors.New("SOCKS5 greeting failed")
	}
	var selected [2]byte
	if _, err := io.ReadFull(conn, selected[:]); err != nil || selected[0] != 5 || selected[1] != method {
		return nil, errors.New("SOCKS5 proxy rejected the configured authentication method")
	}
	if method == 2 {
		if len(secret.Username) < 1 || len(secret.Username) > 255 || len(secret.Password) < 1 || len(secret.Password) > 255 {
			return nil, errors.New("SOCKS5 credentials are invalid")
		}
		auth := append([]byte{1, byte(len(secret.Username))}, []byte(secret.Username)...)
		auth = append(auth, byte(len(secret.Password)))
		auth = append(auth, []byte(secret.Password)...)
		if err := writeNetworkProxyBytes(conn, auth); err != nil {
			return nil, errors.New("SOCKS5 authentication failed")
		}
		if _, err := io.ReadFull(conn, selected[:]); err != nil || selected[0] != 1 || selected[1] != 0 {
			return nil, errors.New("SOCKS5 authentication was rejected")
		}
	}
	host, port, err := net.SplitHostPort(target)
	ip, ipErr := netip.ParseAddr(host)
	n, portErr := strconv.Atoi(port)
	if err != nil || ipErr != nil || ip.Zone() != "" || portErr != nil || n < 1 || n > 65535 {
		return nil, errors.New("SOCKS5 requires a literal destination")
	}
	ip = ip.Unmap()
	request := []byte{5, 1, 0}
	if ip.Is4() {
		request = append(request, 1)
		value := ip.As4()
		request = append(request, value[:]...)
	} else {
		request = append(request, 4)
		value := ip.As16()
		request = append(request, value[:]...)
	}
	request = binary.BigEndian.AppendUint16(request, uint16(n))
	if err := writeNetworkProxyBytes(conn, request); err != nil {
		return nil, errors.New("SOCKS5 CONNECT write failed")
	}
	var reply [4]byte
	if _, err := io.ReadFull(conn, reply[:]); err != nil || reply[0] != 5 || reply[1] != 0 || reply[2] != 0 {
		return nil, errors.New("SOCKS5 CONNECT was rejected")
	}
	length := 0
	switch reply[3] {
	case 1:
		length = 4
	case 4:
		length = 16
	case 3:
		var size [1]byte
		if _, err := io.ReadFull(conn, size[:]); err != nil || size[0] == 0 {
			return nil, errors.New("SOCKS5 returned an invalid bound address")
		}
		length = int(size[0])
	default:
		return nil, errors.New("SOCKS5 returned an invalid address family")
	}
	// BND.ADDR is protocol metadata; it is never resolved or connected to.
	if _, err := io.CopyN(io.Discard, conn, int64(length+2)); err != nil {
		return nil, errors.New("SOCKS5 CONNECT response was incomplete")
	}
	return conn, nil
}

func networkProxyClient(client *http.Client) *http.Client {
	transport := client.Transport.(*http.Transport)
	transport.DialContext = networkProxyGenerationDial(transport.DialContext)
	return client
}
func (a *App) newOutboundIconHTTPClient() *http.Client {
	return networkProxyClient(newIconHTTPClientWithDial(a.dialNetworkTarget))
}
func (a *App) newOutboundIntegrationHTTPClient(private bool) *http.Client {
	return networkProxyClient(integrationHTTPClientWithDial(private, a.dialNetworkTarget))
}
func (a *App) newOutboundGitHubClient() *http.Client {
	return networkProxyClient(integrationGitHubClientWithDial(a.dialNetworkTarget))
}
