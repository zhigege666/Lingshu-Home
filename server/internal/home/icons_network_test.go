package home

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"
)

func testIconNetworkURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := iconRemoteURL(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestIconPrivateOriginsAndPorts(t *testing.T) {
	for _, test := range []struct{ raw, want string }{
		{"http://192.168.1.20:5000/files?token=private#home", "http://192.168.1.20:5000/"},
		{"http://10.2.3.4:8080/admin", "http://10.2.3.4:8080/"},
		{"https://172.16.4.5:3000/private", "https://172.16.4.5:3000/"},
		{"http://[fd12:3456::20]:8096/web?token=private#home", "http://[fd12:3456::20]:8096/"},
		{"http://NAS.local.:80/files", "http://nas.local/"},
		{"https://nas.internal:443/files", "https://nas.internal/"},
		{"http://nas:5000/", "http://nas:5000/"},
		{"https://example.org:8443/", "https://example.org:8443/"},
		{"http://example.org:443/", "http://example.org:443/"},
		{"http://192.168.1.20:1/", "http://192.168.1.20:1/"},
		{"https://192.168.1.20:65535/", "https://192.168.1.20:65535/"},
	} {
		t.Run(test.raw, func(t *testing.T) {
			origin, err := iconWebsiteOrigin(test.raw)
			if err != nil || origin.String() != test.want {
				t.Fatalf("origin = %v, error = %v, want %q", origin, err, test.want)
			}
			if got := automaticIconOrigin(test.raw); got != test.want {
				t.Errorf("automatic origin = %q, want %q", got, test.want)
			}
		})
	}
	// The persisted cache and queue use the full origin: two applications on
	// one NAS must not share a cache key merely because their hostname matches.
	origins := map[string]bool{}
	for _, port := range []string{"80", "443", "3000", "5000", "8080", "8096"} {
		origin := automaticIconOrigin("http://192.168.1.20:" + port + "/private/path?token=x")
		if origin == "" || origins[origin] {
			t.Fatalf("origin cache key lost port %s: %q", port, origin)
		}
		origins[origin] = true
	}
}

func TestIconPrivateOriginsStillBlockReservedTargets(t *testing.T) {
	for _, raw := range []string{
		"http://127.0.0.1:8080/", "http://[::1]:3000/", "http://localhost:5000/", "http://child.localhost/",
		"http://169.254.169.254/", "http://[fe80::1]/", "http://[fd00:ec2::254]/", "http://100.100.100.200/", "http://100.64.1.2/",
		"http://metadata/", "http://metadata.google.internal/", "http://instance-data/", "http://metadata.tencentyun.com/",
		"http://0.0.0.0/", "http://192.0.2.1/", "http://198.18.0.1/", "http://[64:ff9b::a00:1]/", "http://[2002:7f00:1::]/",
		"http://[fd12::1%25eth0]/", "http://192.168.1.20:0/", "http://192.168.1.20:65536/", "http://user:secret@192.168.1.20/",
	} {
		t.Run(raw, func(t *testing.T) {
			if _, err := iconWebsiteOrigin(raw); err == nil {
				t.Error("blocked website origin accepted")
			}
			if origin := automaticIconOrigin(raw); origin != "" {
				t.Errorf("blocked destination queued as %q", origin)
			}
		})
	}
}

func TestIconScopedDNSPinning(t *testing.T) {
	ctx := iconNetworkContext(context.Background(), testIconNetworkURL(t, "http://nas.lan:8096/"))
	for _, test := range []struct {
		name, address, want string
		ips                 []string
	}{
		{name: "initial private IPv4", address: "nas.lan:8096", ips: []string{"192.168.1.20"}, want: "192.168.1.20:8096"},
		{name: "initial private IPv6", address: "nas.lan:5000", ips: []string{"fd12::20"}, want: "[fd12::20]:5000"},
		{name: "public CDN", address: "cdn.example.org:8443", ips: []string{"1.1.1.1"}, want: "1.1.1.1:8443"},
		{name: "private CDN denied", address: "cdn.example.org:8080", ips: []string{"192.168.1.30"}},
		{name: "mixed public private CDN denied", address: "cdn.example.org:8080", ips: []string{"1.1.1.1", "10.1.2.3"}},
		{name: "mixed private loopback denied", address: "nas.lan:8096", ips: []string{"192.168.1.20", "127.0.0.1"}},
		{name: "mixed private metadata denied", address: "nas.lan:8096", ips: []string{"fd12::20", "fd00:ec2::254"}},
		{name: "private CGNAT denied", address: "nas.lan:8096", ips: []string{"100.100.100.200"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			resolver := &iconTestResolver{}
			for _, raw := range test.ips {
				resolver.ips = append(resolver.ips, netip.MustParseAddr(raw))
			}
			var dials []string
			dial := iconPinnedDial(resolver, func(_ context.Context, _, address string) (net.Conn, error) {
				dials = append(dials, address)
				first, second := net.Pipe()
				_ = second.Close()
				return first, nil
			})
			conn, err := dial(ctx, "tcp", test.address)
			if conn != nil {
				_ = conn.Close()
			}
			if test.want == "" {
				if err == nil || len(dials) != 0 {
					t.Fatalf("blocked DNS set reached dial: %v, %v", dials, err)
				}
			} else if err != nil || !reflect.DeepEqual(dials, []string{test.want}) {
				t.Fatalf("target was not pinned: %v, %v", dials, err)
			}
			if resolver.calls != 1 {
				t.Errorf("DNS lookups = %d, want one", resolver.calls)
			}
		})
	}
}

func TestIconScopedRedirectsAndHTMLCandidates(t *testing.T) {
	origin := testIconNetworkURL(t, "http://nas.lan:8096/")
	png := testIconPNG(t, 16, 16)
	var requests []string
	client := &http.Client{Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		requests = append(requests, r.URL.String())
		if !iconPrivateTarget(r.Context(), "nas.lan") || iconPrivateTarget(r.Context(), "cdn.example.org") {
			t.Fatal("redirect reset the initial hostname scope")
		}
		switch r.URL.String() {
		case "http://nas.lan:8096/":
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://cdn.example.org/page"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		case "https://cdn.example.org/page":
			body := `<head><link rel="icon" href="http://192.168.1.99:3000/forbidden.png"><link rel="icon" href="https://nas.lan:5000/icon.png"></head>`
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
		case "https://nas.lan:5000/icon.png":
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(bytes.NewReader(png))}, nil
		default:
			t.Fatalf("unapproved icon request %s", r.URL)
			return nil, fmt.Errorf("unapproved icon request")
		}
	}), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	icon, source, err := fetchWebsiteIcon(context.Background(), client, origin)
	if err != nil || icon.Width != 16 || source != "https://nas.lan:5000/icon.png" || len(requests) != 3 {
		t.Fatalf("private same-host icon fetch failed: source=%q requests=%v error=%v", source, requests, err)
	}

	for _, location := range []string{"http://10.1.2.3:8080/icon.png", "http://[fd12::30]:5000/icon.png", "http://169.254.169.254/latest/meta-data/"} {
		t.Run(location, func(t *testing.T) {
			calls := 0
			redirect := &http.Client{Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{location}}, Body: io.NopCloser(strings.NewReader(""))}, nil
			}), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			ctx := iconNetworkContext(context.Background(), origin)
			if _, _, _, err := fetchIconDocument(ctx, redirect, origin, &iconFetchBudget{}, iconMaxBytes); err == nil || calls != 1 {
				t.Fatalf("cross-host private/metadata redirect was not blocked before transport: calls=%d error=%v", calls, err)
			}
		})
	}
}

func TestIconScopedSameHostRedirect(t *testing.T) {
	origin := testIconNetworkURL(t, "http://192.168.1.20:8096/")
	png := testIconPNG(t, 16, 16)
	var requests []string
	client := &http.Client{Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		requests = append(requests, r.URL.String())
		if len(requests) == 1 {
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://192.168.1.20:5000/favicon.png"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(bytes.NewReader(png))}, nil
	}), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	_, source, err := fetchWebsiteIcon(context.Background(), client, origin)
	if err != nil || source != "https://192.168.1.20:5000/favicon.png" || len(requests) != 2 {
		t.Fatalf("same-host scheme/port redirect failed: %q %v %v", source, requests, err)
	}
}

func TestIconPublicHTMLCannotSelectPrivateHosts(t *testing.T) {
	origin := testIconNetworkURL(t, "https://public.example.org/")
	ctx := iconNetworkContext(context.Background(), origin)
	body := []byte(`<head><link rel="icon" href="http://192.168.1.20:8080/private.png"><link rel="icon" href="http://[fd12::20]:5000/private.png"><link rel="icon" href="http://nas.lan:8096/private.png"><link rel="icon" href="https://cdn.example.org:8443/public.png"></head>`)
	candidates := scopedIconHTMLCandidates(ctx, body, origin)
	if len(candidates) != 1 || candidates[0].String() != "https://cdn.example.org:8443/public.png" {
		t.Fatalf("public page selected a private candidate: %v", candidates)
	}
	// Following a public CDN must not make that CDN a newly private-capable
	// initial host, even when another fetch helper receives the context.
	nested := iconNetworkContext(ctx, candidates[0])
	if iconPrivateTarget(nested, "cdn.example.org") || !iconPrivateTarget(nested, "public.example.org") {
		t.Fatal("nested discovery widened the original private-host permission")
	}
}

func TestComponentTemplatePrivateNetworkScope(t *testing.T) {
	const manifest = `{"format":"lingshu-home-component","manifestVersion":1,"id":"local/navigation","version":"1.0.0","name":"Local navigation","license":"MIT","renderer":"builtin/navigation","dataSchema":{"id":"navigation.collection","version":1},"settings":{},"layout":{"width":12,"height":6}}`
	const initial = "http://templates.lan:3000/catalog"
	const destination = "https://templates.lan:8443/template.json"
	var requests []string
	client := &http.Client{Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		requests = append(requests, r.URL.String())
		if !iconPrivateTarget(r.Context(), "templates.lan") || iconPrivateTarget(r.Context(), "cdn.example.org") {
			t.Fatal("template discovery reset the initial hostname scope")
		}
		switch r.URL.String() {
		case initial:
			return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://cdn.example.org/catalog"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		case "https://cdn.example.org/catalog":
			body := `<head><link rel="lingshu-home-component" href="` + destination + `" title="Local navigation"></head>`
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
		case destination:
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(manifest))}, nil
		default:
			return nil, fmt.Errorf("unapproved template request %s", r.URL)
		}
	}), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	preview, err := fetchComponentTemplate(context.Background(), client, initial)
	if err != nil || preview.SourceURL != destination || len(requests) != 3 {
		t.Fatalf("private template preview failed: %+v, requests=%v, error=%v", preview, requests, err)
	}
	if err := validateComponentTemplateReference(map[string]any{"id": preview.Manifest.ID, "version": preview.Manifest.Version, "sha256": preview.SHA256, "sourceUrl": preview.SourceURL}); err != nil {
		t.Fatalf("private template preview cannot be saved: %v", err)
	}
	if err := validateComponentTemplateReference(map[string]any{"id": preview.Manifest.ID, "version": preview.Manifest.Version, "sha256": preview.SHA256, "sourceUrl": "http://169.254.169.254/template.json"}); err == nil {
		t.Fatal("template reference accepted a metadata source")
	}
	requests = nil
	discovery, err := discoverComponentTemplates(context.Background(), client, initial)
	if err != nil || len(discovery.Templates) != 1 || discovery.Templates[0].URL != destination || len(requests) != 2 {
		t.Fatalf("private template discovery failed: %+v, requests=%v, error=%v", discovery, requests, err)
	}

	for _, redirect := range []bool{false, true} {
		t.Run(fmt.Sprintf("cross-host-redirect-%t", redirect), func(t *testing.T) {
			calls := 0
			blocked := &http.Client{Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				if redirect {
					return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"http://10.1.2.3:5000/template.json"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
				}
				body := `<head><link rel="lingshu-home-component" href="http://10.1.2.3:5000/template.json"></head>`
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/html"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
			}), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			if _, err := fetchComponentTemplate(context.Background(), blocked, initial); err == nil || calls != 1 {
				t.Fatalf("private template target escaped initial scope: calls=%d error=%v", calls, err)
			}
			calls = 0
			if _, err := discoverComponentTemplates(context.Background(), blocked, initial); err == nil || calls != 1 {
				t.Fatalf("private template discovery escaped initial scope: calls=%d error=%v", calls, err)
			}
		})
	}
}

func TestIconPrivateProxyTargetBoundary(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ctx = iconNetworkContext(ctx, testIconNetworkURL(t, "http://nas.lan:8096/"))
	proxyURL, _ := url.Parse("http://127.0.0.1:3128")
	runtime := &networkProxyRuntime{config: NetworkProxyConfig{Mode: "proxy"}, endpoint: proxyURL}
	connect := make(chan string, 1)
	proxyDials := 0
	options := networkProxyDialOptions{resolver: &iconTestResolver{}, dial: func(_ context.Context, _, address string) (net.Conn, error) {
		proxyDials++
		if address != "127.0.0.1:3128" {
			return nil, fmt.Errorf("unapproved proxy dial %s", address)
		}
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			_ = server.SetDeadline(time.Now().Add(2 * time.Second))
			reader := bufio.NewReader(server)
			var head strings.Builder
			for {
				line, err := reader.ReadString('\n')
				if err != nil {
					connect <- "read error: " + err.Error()
					return
				}
				head.WriteString(line)
				if line == "\r\n" {
					break
				}
			}
			connect <- head.String()
			if _, err := io.WriteString(server, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
				return
			}
			// Keep the established tunnel alive until its client closes it. Closing
			// the pipe after CONNECT races the client's handshake deadline reset.
			_, _ = io.Copy(io.Discard, reader)
		}()
		return client, nil
	}}
	resolver := &iconTestResolver{ips: []netip.Addr{netip.MustParseAddr("192.168.1.20")}}
	dial := iconPinnedDial(resolver, func(ctx context.Context, network, address string) (net.Conn, error) {
		return dialNetworkProxyTarget(ctx, network, address, runtime, options)
	})
	conn, err := dial(ctx, "tcp", "nas.lan:8096")
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	select {
	case head := <-connect:
		if !strings.HasPrefix(head, "CONNECT 192.168.1.20:8096 HTTP/1.1\r\n") || strings.Contains(head, "nas.lan") {
			t.Fatalf("proxy received an unpinned hostname: %q", head)
		}
	case <-ctx.Done():
		t.Fatal("proxy CONNECT was not observed")
	}
	if proxyDials != 1 || resolver.calls != 1 {
		t.Fatalf("unexpected DNS/proxy calls: %d/%d", resolver.calls, proxyDials)
	}
	if _, err := dial(ctx, "tcp", "cdn.example.org:8096"); err == nil || proxyDials != 1 {
		t.Fatal("cross-host private target reached the proxy")
	}
	if _, err := dialNetworkProxyTarget(ctx, "tcp", "169.254.169.254:80", runtime, options); err == nil || proxyDials != 1 {
		t.Fatal("proxy adapter accepted a metadata destination")
	}
}
