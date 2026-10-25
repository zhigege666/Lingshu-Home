package home

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const iconFixtureSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12 12 4 20 12"/><rect x="6" y="12" width="12" height="8" rx="2"/></svg>`

func testIconPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: 20, G: 160, B: 130, A: uint8(100 + x%155)})
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestIconImageNormalization(t *testing.T) {
	icon, err := normalizeIcon([]byte(iconFixtureSVG), "image/svg+xml")
	if err != nil || icon.Width != 24 || icon.Height != 24 || strings.Count(string(icon.Content), "xmlns=") != 1 || !iconDigestPattern.MatchString(icon.Digest) {
		t.Fatalf("invalid normalized SVG: %+v %v", icon, err)
	}
	files, err := filepath.Glob("../../../assets/icons/lucide/*.svg")
	if err != nil || len(files) < 30 {
		t.Fatal("missing bundled icon fixtures")
	}
	for _, name := range files {
		t.Run(filepath.Base(name), func(t *testing.T) {
			body, err := os.ReadFile(name)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = normalizeIcon(body, "image/svg+xml"); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, bad := range []string{
		`<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>`,
		`<svg viewBox="0 0 24 24" onload="alert(1)"></svg>`,
		`<svg viewBox="0 0 24 24"><foreignObject><div>hello</div></foreignObject></svg>`,
		`<svg viewBox="0 0 24 24"><image href="http://127.0.0.1/secret"/></svg>`,
		`<svg viewBox="0 0 24 24"><use href="#x"/></svg>`,
		`<svg viewBox="0 0 24 24"><path style="fill:url(http://example.org/x)" d="M0 0"/></svg>`,
		`<svg viewBox="0 0 24 24"><path fill="url(#x)" d="M0 0"/></svg>`,
		`<svg viewBox="0 0 24 24"><animate attributeName="x"/></svg>`,
		`<svg viewBox="0 0 24 24" xmlns:x="urn:private"><x:path d="M0 0"/></svg>`,
		`<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 24 24">&x;</svg>`,
		`<?xml-stylesheet href="https://example.org/style"?><svg viewBox="0 0 24 24"/>`,
		`<svg viewBox="0 0 999999 999999"/>`,
		`<svg viewBox="0 0 NaN 24"/>`,
		`<svg viewBox="0 0 24 24"/><svg viewBox="0 0 24 24"/>`,
		`<html><svg viewBox="0 0 24 24"/></html>`,
		`<svg viewBox="0 0 24 24">` + strings.Repeat(`<g>`, 18) + strings.Repeat(`</g>`, 18) + `</svg>`,
	} {
		if _, err := normalizeIcon([]byte(bad), "image/svg+xml"); err == nil {
			t.Fatalf("unsafe SVG accepted: %.100s", bad)
		}
	}
	raster := testIconPNG(t, 32, 32)
	converted, err := normalizeIcon(raster, "image/png")
	if err != nil || converted.Width != 32 || converted.Height != 32 {
		t.Fatal(err)
	}
	if _, err = normalizeIcon(raster, "image/jpeg"); err == nil {
		t.Fatal("MIME mismatch accepted")
	}
	if _, err = normalizeIcon(testIconPNG(t, 513, 1), "image/png"); err == nil {
		t.Fatal("excessive image dimension accepted")
	}
	if _, err = normalizeIcon(bytes.Repeat([]byte("x"), iconMaxBytes+1), "image/png"); err == nil {
		t.Fatal("excessive image body accepted")
	}
	var jpegBytes bytes.Buffer
	if err = jpeg.Encode(&jpegBytes, image.NewRGBA(image.Rect(0, 0, 16, 16)), nil); err != nil {
		t.Fatal(err)
	}
	converted, err = normalizeIcon(jpegBytes.Bytes(), "image/jpeg")
	if err != nil || converted.MediaType != "image/png" || !bytes.HasPrefix(converted.Content, []byte{137, 80, 78, 71}) {
		t.Fatal("JPEG was not rewritten as PNG", err)
	}
}

func TestIconICOConversion(t *testing.T) {
	encoded := testIconPNG(t, 32, 32)
	ico := make([]byte, 22+len(encoded))
	copy(ico, []byte{0, 0, 1, 0, 1, 0, 32, 32, 0, 0, 1, 0, 32, 0})
	binary.LittleEndian.PutUint32(ico[14:18], uint32(len(encoded)))
	binary.LittleEndian.PutUint32(ico[18:22], 22)
	copy(ico[22:], encoded)
	icon, err := normalizeFetchedIcon(ico, "image/x-icon")
	if err != nil || icon.Width != 32 || icon.Height != 32 || icon.MediaType != "image/png" {
		t.Fatal("PNG ICO conversion failed", err)
	}
	bad := append([]byte(nil), ico...)
	binary.LittleEndian.PutUint32(bad[18:22], uint32(len(bad)+1))
	if _, err = normalizeFetchedIcon(bad, "image/x-icon"); err == nil {
		t.Fatal("out-of-bounds ICO offset accepted")
	}
	for _, bits := range []int{24, 32} {
		rowBytes := ((2*bits + 31) / 32) * 4
		dib := make([]byte, 40+rowBytes*2+8)
		binary.LittleEndian.PutUint32(dib[:4], 40)
		binary.LittleEndian.PutUint32(dib[4:8], 2)
		binary.LittleEndian.PutUint32(dib[8:12], 4)
		binary.LittleEndian.PutUint16(dib[12:14], 1)
		binary.LittleEndian.PutUint16(dib[14:16], uint16(bits))
		copy(dib[40:], []byte{20, 160, 30})
		copy(dib[40+rowBytes:], []byte{70, 90, 200})
		decoded, err := iconDecodeDIB(dib, 2, 2)
		if err != nil {
			t.Fatal(err)
		}
		r, g, b, a := decoded.At(0, 0).RGBA()
		if r != 200*257 || g != 90*257 || b != 70*257 || a != 65535 {
			t.Fatalf("DIB orientation/color conversion incorrect %d %d %d %d", r, g, b, a)
		}
		if _, err = iconDecodeDIB(dib[:41], 2, 2); err == nil {
			t.Fatal("truncated DIB accepted")
		}
	}
}

type iconTestResolver struct {
	ips   []netip.Addr
	calls int
}

func (r *iconTestResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	r.calls++
	return r.ips, nil
}

func TestIconPublicAddressAndPinnedConnection(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "10.1.2.3", "100.100.100.200", "169.254.169.254", "192.168.1.1", "172.16.0.1", "0.0.0.0", "198.18.0.1", "192.0.2.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8%eth0", "64:ff9b::a00:1", "2002:7f00:1::", "2001:db8::1", "3ffe::1", "3fff::1"} {
		if iconPublicIP(netip.MustParseAddr(raw)) {
			t.Errorf("non-public address accepted: %s", raw)
		}
	}
	for _, raw := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if !iconPublicIP(netip.MustParseAddr(raw)) {
			t.Errorf("public address rejected: %s", raw)
		}
	}
	for _, raw := range []string{"http://127.0.0.1/a", "http://localhost/a", "http://[::1]/", "https://user:secret@example.org/", "ftp://example.org/", "https://example.org/%0a", "https://example.org\\@evil.example.org/", "https://bad_host.example.org/"} {
		// Escaped path bytes are legal navigation URLs, but are stripped before a
		// website-origin request. All direct unsafe targets must be rejected.
		if strings.Contains(raw, "%0a") {
			origin, err := iconWebsiteOrigin(raw)
			if err != nil || origin.Path != "/" {
				t.Fatal("origin stripping failed")
			}
			continue
		}
		if _, err := iconWebsiteOrigin(raw); err == nil {
			t.Errorf("unsafe URL accepted: %s", raw)
		}
	}
	origin, err := iconWebsiteOrigin("https://Example.ORG/private/path?token=do-not-forward#fragment")
	if err != nil || origin.String() != "https://example.org/" {
		t.Fatal("private URL components retained", origin, err)
	}
	r := &iconTestResolver{ips: []netip.Addr{netip.MustParseAddr("1.1.1.1")}}
	dials := []string{}
	dial := iconPinnedDial(r, func(ctx context.Context, network, address string) (net.Conn, error) {
		dials = append(dials, address)
		first, second := net.Pipe()
		_ = second.Close()
		return first, nil
	})
	conn, err := dial(context.Background(), "tcp", "example.org:443")
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if r.calls != 1 || !reflect.DeepEqual(dials, []string{"1.1.1.1:443"}) {
		t.Fatalf("DNS was not pinned: calls=%d dials=%v", r.calls, dials)
	}
	r.ips = append(r.ips, netip.MustParseAddr("127.0.0.1"))
	dials = nil
	if _, err = dial(context.Background(), "tcp", "example.org:443"); err == nil || len(dials) != 0 {
		t.Fatal("mixed public/private DNS allowed a connection")
	}
	client := newIconHTTPClient()
	transport := client.Transport.(*http.Transport)
	if transport.Proxy != nil || !transport.DisableCompression || !transport.DisableKeepAlives || client.Jar != nil || client.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
		t.Fatal("website client retains ambient proxy/cookies/redirect behavior")
	}
}

func TestIconWebsiteDiscoveryRedirectsAndBudget(t *testing.T) {
	pngBytes := testIconPNG(t, 32, 32)
	var requests []string
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		requests = append(requests, r.URL.String())
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Referer") != "" {
			t.Fatal("sensitive headers forwarded")
		}
		header := http.Header{}
		if r.URL.Path == "/" {
			header.Set("Content-Type", "text/html")
			return &http.Response{StatusCode: 200, Header: header, Body: io.NopCloser(strings.NewReader(`<html><head><link rel="icon" href="http://127.0.0.1/no"><link rel="apple-touch-icon" href="/safe.png"></head><body></body></html>`))}, nil
		}
		if r.URL.Path == "/safe.png" {
			header.Set("Content-Type", "image/png")
			return &http.Response{StatusCode: 200, Header: header, Body: io.NopCloser(bytes.NewReader(pngBytes))}, nil
		}
		return nil, errors.New("unexpected request")
	})}
	origin, _ := iconWebsiteOrigin("https://example.org/private?token=x")
	icon, source, err := fetchWebsiteIcon(context.Background(), client, origin)
	if err != nil || icon.Width != 32 || source != "https://example.org/safe.png" || !reflect.DeepEqual(requests, []string{"https://example.org/", "https://example.org/safe.png"}) {
		t.Fatal("icon discovery failed", requests, source, err)
	}
	requests = nil
	client.Transport = integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		requests = append(requests, r.URL.String())
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"http://169.254.169.254/latest/meta-data/"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})
	if _, _, _, err = fetchIconDocument(context.Background(), client, origin, &iconFetchBudget{}, 512<<10); err == nil || len(requests) != 1 {
		t.Fatal("redirect policy allowed a metadata request", requests)
	}
	requests = nil
	client.Transport = integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		requests = append(requests, r.URL.String())
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"/redirect"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})
	if _, _, _, err = fetchIconDocument(context.Background(), client, origin, &iconFetchBudget{}, 512<<10); err == nil || len(requests) != 4 {
		t.Fatal("redirect limit failed", len(requests))
	}
	client.Transport = integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(bytes.NewReader(bytes.Repeat([]byte{1}, iconMaxBytes+1)))}, nil
	})
	if _, _, _, err = fetchIconDocument(context.Background(), client, origin, &iconFetchBudget{}, iconMaxBytes); err == nil {
		t.Fatal("oversized response accepted")
	}
	client.Transport = integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Encoding": []string{"gzip"}}, Body: io.NopCloser(bytes.NewReader(pngBytes))}, nil
	})
	if _, _, _, err = fetchIconDocument(context.Background(), client, origin, &iconFetchBudget{}, iconMaxBytes); err == nil {
		t.Fatal("compressed response bypass accepted")
	}
}

type iconObservedBody struct {
	reader io.Reader
	read   int
	closed bool
}

func (body *iconObservedBody) Read(p []byte) (int, error) {
	n, err := body.reader.Read(p)
	body.read += n
	return n, err
}

func (body *iconObservedBody) Close() error { body.closed = true; return nil }

// A streaming response with a prompt prefix followed by a body that waits for
// the request deadline. Closing after </head> must not read its slow tail.
type iconSlowHTMLBody struct {
	ctx    context.Context
	prefix []byte
	read   int
	waited bool
	closed bool
}

func (body *iconSlowHTMLBody) Read(p []byte) (int, error) {
	if len(body.prefix) > 0 {
		n := copy(p, body.prefix)
		body.prefix = body.prefix[n:]
		body.read += n
		return n, nil
	}
	body.waited = true
	<-body.ctx.Done()
	return 0, body.ctx.Err()
}

func (body *iconSlowHTMLBody) Close() error { body.closed = true; return nil }

func TestIconHTMLHeadStopsBeforeSlowBody(t *testing.T) {
	pngBytes := testIconPNG(t, 32, 32)
	origin, _ := iconWebsiteOrigin("https://example.org/")
	for _, mediaType := range []string{"text/html", "application/xhtml+xml"} {
		for _, terminator := range []string{"</head>", "<body>"} {
			for _, contentLength := range []int64{-1, 4 * iconHeadMaxBytes} {
				name := mediaType + terminator + "-unknown-length"
				if contentLength > 0 {
					name = mediaType + terminator + "-large-declared-length"
				}
				t.Run(name, func(t *testing.T) {
					var stream *iconSlowHTMLBody
					var paths []string
					client := &http.Client{Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
						paths = append(paths, r.URL.Path)
						if r.URL.Path == "/" {
							stream = &iconSlowHTMLBody{ctx: r.Context(), prefix: []byte(`<html><head><link rel="icon" href="/safe.png">` + terminator)}
							return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{mediaType}}, ContentLength: contentLength, Body: stream}, nil
						}
						return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, ContentLength: int64(len(pngBytes)), Body: io.NopCloser(bytes.NewReader(pngBytes))}, nil
					})}
					start := time.Now()
					icon, source, err := fetchWebsiteIcon(context.Background(), client, origin)
					if err != nil || icon.Width != 32 || source != "https://example.org/safe.png" || !reflect.DeepEqual(paths, []string{"/", "/safe.png"}) {
						t.Fatal("large/streaming HTML head discovery failed", paths, source, err)
					}
					if stream.waited || !stream.closed || stream.read > iconHeadMaxBytes || time.Since(start) >= time.Second {
						t.Fatal("icon discovery waited for the page body or left it open", stream.read, stream.waited, stream.closed)
					}
				})
			}
		}
	}
	if got := iconHTMLCandidates([]byte(`<head></head><link rel="icon" href="/after-head.png"><body>`), origin); len(got) != 0 {
		t.Fatal("candidate parser accepted a link after the head", got)
	}
}

func TestIconHTMLPrefixAndBinaryLimits(t *testing.T) {
	origin, _ := iconWebsiteOrigin("https://example.org/")
	head := `<html><head><link rel="icon" href="/safe.png"><meta content="` + strings.Repeat("x", 2*iconHeadMaxBytes)
	observed := &iconObservedBody{reader: strings.NewReader(head)}
	client := &http.Client{Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/html"}}, ContentLength: int64(len(head)), Body: observed}, nil
	})}
	budget := &iconFetchBudget{}
	body, kind, page, err := fetchIconResponse(context.Background(), client, origin, budget, iconDocumentPolicy{maxBytes: iconHeadMaxBytes, htmlHead: true})
	if err != nil || kind != "text/html" || len(body) != iconHeadMaxBytes || observed.read != iconHeadMaxBytes || !observed.closed || budget.bytes != observed.read {
		t.Fatal("large HTML did not retain a bounded prefix", len(body), observed.read, budget, err)
	}
	if candidates := iconHTMLCandidates(body, page); len(candidates) != 1 || candidates[0].Path != "/safe.png" {
		t.Fatal("complete icon tag was lost at the head byte limit", candidates)
	}
	for _, mediaType := range []string{"image/png", "image/svg+xml", "application/octet-stream", "text/plain"} {
		for _, length := range []int64{-1, iconMaxBytes + 1} {
			observed = &iconObservedBody{reader: bytes.NewReader(bytes.Repeat([]byte{'x'}, iconMaxBytes+1))}
			client.Transport = integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{mediaType}}, ContentLength: length, Body: observed}, nil
			})
			budget = &iconFetchBudget{}
			if _, _, _, err = fetchIconResponse(context.Background(), client, origin, budget, iconDocumentPolicy{maxBytes: iconHeadMaxBytes, htmlHead: true}); err == nil {
				t.Fatalf("non-HTML response accepted as a partial head: %s length=%d", mediaType, length)
			}
			if !observed.closed || observed.read > iconMaxBytes+1 || budget.bytes != observed.read || length > 0 && observed.read != 0 {
				t.Fatal("binary response bypassed size/accounting/close policy", observed, budget)
			}
		}
	}
	pngBytes := testIconPNG(t, 16, 16)
	client.Transport = integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, ContentLength: int64(len(pngBytes) + 1), Body: io.NopCloser(bytes.NewReader(pngBytes))}, nil
	})
	if _, _, _, err = fetchIconDocument(context.Background(), client, origin, &iconFetchBudget{}, iconMaxBytes); err == nil {
		t.Fatal("truncated declared image accepted")
	}
	// Reading an HTML prefix must never make the strict image/document helper
	// accept incomplete HTML when that permissive page mode was not requested.
	client.Transport = integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/html"}}, ContentLength: int64(len(head)), Body: io.NopCloser(strings.NewReader(head))}, nil
	})
	if _, _, _, err = fetchIconDocument(context.Background(), client, origin, &iconFetchBudget{}, iconHeadMaxBytes); err == nil {
		t.Fatal("strict document fetch acquired implicit prefix behavior")
	}
}

func TestIconSlowHeadLeavesFallbackTime(t *testing.T) {
	pngBytes := testIconPNG(t, 16, 16)
	origin, _ := iconWebsiteOrigin("https://example.org/")
	var stream *iconSlowHTMLBody
	var paths []string
	client := &http.Client{Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		paths = append(paths, r.URL.Path)
		deadline, ok := r.Context().Deadline()
		if !ok {
			t.Fatal("website request has no deadline")
		}
		if r.URL.Path == "/" {
			if time.Until(deadline) > iconHeadTimeout+time.Second/4 {
				t.Fatal("initial page can consume the complete lookup deadline")
			}
			stream = &iconSlowHTMLBody{ctx: r.Context(), prefix: []byte("<html><head>")}
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/html"}}, ContentLength: -1, Body: stream}, nil
		}
		if r.URL.Path != "/favicon.ico" || r.Context().Err() != nil || time.Until(deadline) < iconFallbackTime {
			t.Fatal("slow head prevented an uncancelled fallback", r.URL, r.Context().Err())
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, ContentLength: int64(len(pngBytes)), Body: io.NopCloser(bytes.NewReader(pngBytes))}, nil
	})}
	start := time.Now()
	icon, source, err := fetchWebsiteIcon(context.Background(), client, origin)
	if err != nil || icon.Width != 16 || source != "https://example.org/favicon.ico" || !reflect.DeepEqual(paths, []string{"/", "/favicon.ico"}) {
		t.Fatal("slow head did not fall back", paths, source, err)
	}
	if !stream.waited || !stream.closed || time.Since(start) > iconHeadTimeout+time.Second {
		t.Fatal("head deadline was not bounded or the response remained open", stream, time.Since(start))
	}
}

func TestIconFallbackAndGlobalBudgets(t *testing.T) {
	pngBytes := testIconPNG(t, 16, 16)
	origin, _ := iconWebsiteOrigin("https://example.org/")
	for _, exhausted := range []string{"requests", "bytes"} {
		t.Run(exhausted, func(t *testing.T) {
			var paths []string
			var bodies []*iconObservedBody
			client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
				paths = append(paths, r.URL.Path)
				header := http.Header{}
				content, status, length := "", 200, int64(-1)
				if r.URL.Path == "/" {
					header.Set("Content-Type", "text/html")
					content = `<head><link rel="icon" href="/candidate-1"><link rel="icon" href="/candidate-2"><link rel="icon" href="/candidate-3">`
					if exhausted == "bytes" {
						content += `<meta content="` + strings.Repeat("x", 2*iconHeadMaxBytes)
						length = int64(len(content))
					} else {
						content += `</head>`
					}
				} else if r.URL.Path == "/favicon.ico" {
					header.Set("Content-Type", "image/png")
					content = string(pngBytes)
					length = int64(len(content))
				} else {
					deadline, _ := r.Context().Deadline()
					if time.Until(deadline) > iconFetchTimeout-iconFallbackTime+time.Second/4 {
						t.Fatal("declared candidate has no fallback time reserve")
					}
					if exhausted == "requests" {
						status = 302
						header.Set("Location", "/candidate-redirect")
					} else {
						header.Set("Content-Type", "image/png")
						content = strings.Repeat("x", iconMaxBytes+1)
					}
				}
				body := &iconObservedBody{reader: strings.NewReader(content)}
				bodies = append(bodies, body)
				return &http.Response{StatusCode: status, Header: header, ContentLength: length, Body: body}, nil
			})}
			icon, source, err := fetchWebsiteIcon(context.Background(), client, origin)
			if err != nil || icon.Width != 16 || source != "https://example.org/favicon.ico" || paths[len(paths)-1] != "/favicon.ico" || len(paths) > iconFetchMaxRequests {
				t.Fatal("fallback reserve failed", paths, source, err)
			}
			if exhausted == "requests" && len(paths) != iconFetchMaxRequests || exhausted == "bytes" && len(paths) != 3 {
				t.Fatal("unexpected reserve request count", paths)
			}
			read := 0
			for _, body := range bodies {
				read += body.read
				if !body.closed {
					t.Fatal("response body left open")
				}
			}
			if read > iconFetchMaxBytes || exhausted == "bytes" && read != iconHeadMaxBytes+iconMaxBytes+len(pngBytes) {
				t.Fatal("total byte accounting exceeded or omitted the bounded prefix", read)
			}
		})
	}
	for _, htmlHead := range []bool{false, true} {
		observed := &iconObservedBody{reader: strings.NewReader(strings.Repeat("x", 128))}
		requests := 0
		client := &http.Client{Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
			requests++
			kind := "image/png"
			if htmlHead {
				kind = "text/html"
			}
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{kind}}, ContentLength: -1, Body: observed}, nil
		})}
		budget := &iconFetchBudget{bytes: iconFetchMaxBytes - 17}
		_, _, _, err := fetchIconResponse(context.Background(), client, origin, budget, iconDocumentPolicy{maxBytes: iconHeadMaxBytes, htmlHead: htmlHead})
		if !htmlHead && err == nil {
			t.Fatal("unknown-length binary was truncated to the remaining budget and accepted")
		}
		if budget.bytes != iconFetchMaxBytes || observed.read != 17 || !observed.closed {
			t.Fatal("read crossed the global byte limit", budget, observed)
		}
		if _, _, _, err = fetchIconDocument(context.Background(), client, origin, budget, iconMaxBytes); err == nil || requests != 1 {
			t.Fatal("exhausted budget started another HTTP request", requests, err)
		}
	}
}

type iconHTTPBrowser struct {
	t       *testing.T
	a       *App
	csrf    string
	cookies map[string]*http.Cookie
}

func newIconHTTPBrowser(t *testing.T, a *App) *iconHTTPBrowser {
	return &iconHTTPBrowser{t: t, a: a, cookies: map[string]*http.Cookie{}}
}
func (b *iconHTTPBrowser) request(method, path string, body any, headers http.Header) *httptest.ResponseRecorder {
	b.t.Helper()
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		if err != nil {
			b.t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, "http://home.test"+path, bytes.NewReader(encoded))
	r.RemoteAddr = "192.0.2.50:2000"
	for _, cookie := range b.cookies {
		r.AddCookie(cookie)
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if method != "GET" {
		r.Header.Set("X-CSRF-TOKEN", b.csrf)
	}
	for key, values := range headers {
		r.Header[key] = values
	}
	w := httptest.NewRecorder()
	b.a.ServeHTTP(w, r)
	for _, cookie := range w.Result().Cookies() {
		if cookie.MaxAge < 0 {
			delete(b.cookies, cookie.Name)
		} else {
			b.cookies[cookie.Name] = cookie
		}
	}
	return w
}
func (b *iconHTTPBrowser) object(method, path string, body any, status int) map[string]any {
	b.t.Helper()
	w := b.request(method, "/api/v1"+path, body, nil)
	if w.Code != status {
		b.t.Fatalf("%s %s status %d want %d: %s", method, path, w.Code, status, w.Body)
	}
	result := map[string]any{}
	if status != 204 {
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			b.t.Fatal(err)
		}
	}
	return result
}
func (b *iconHTTPBrowser) bootstrap() map[string]any {
	b.t.Helper()
	boot := b.object("GET", "/bootstrap", nil, 200)
	b.csrf = boot["csrfToken"].(string)
	return boot
}
func iconPackFixture() map[string]any {
	return map[string]any{"schemaVersion": 1, "name": "Personal outline", "sourceUrl": "https://example.org/icons", "license": "Original fixture artwork, Apache-2.0", "icons": []any{map[string]any{"key": "home", "label": "Home", "mediaType": "image/svg+xml", "dataBase64": base64.StdEncoding.EncodeToString([]byte(iconFixtureSVG))}}}
}

func TestIconHTTPStorageAndPermissions(t *testing.T)         { testIconHTTPStorage(t, false) }
func TestIconHTTPPostgresStorageAndPermissions(t *testing.T) { testIconHTTPStorage(t, true) }

func testIconHTTPStorage(t *testing.T, postgres bool) {
	c := coreConfig(t, false)
	if postgres {
		c.DatabaseURL = os.Getenv("LINGSHU_TEST_ICONS_POSTGRES_URL")
		if c.DatabaseURL == "" {
			t.Skip("requires a fresh dedicated LINGSHU_TEST_ICONS_POSTGRES_URL")
		}
		c.StorageProvider = "postgres"
	}
	a, err := Open(c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	s, err := a.loadSettings(context.Background(), a.store.DB)
	if err != nil {
		t.Fatal(err)
	}
	if s.Initialized {
		t.Fatal("icon tests require a fresh dedicated database; existing data is not erased")
	}
	owner := newIconHTTPBrowser(t, a)
	owner.bootstrap()
	owner.object("POST", "/setup", map[string]any{"siteName": "Icon fixture", "mode": "private_multi", "username": "icon-owner", "password": "icon-fixture-owner-2026", "displayName": "Icon owner", "seedDemo": false}, 201)
	boot := owner.bootstrap()
	shared := coreSpace(boot, "shared")
	personal := coreSpace(boot, "personal")
	spacePath := "/spaces/" + shared
	pack := owner.object("POST", spacePath+"/icon-packs", iconPackFixture(), 201)
	entry := pack["icons"].([]any)[0].(map[string]any)
	ref := entry["ref"].(string)
	assetURL := entry["url"].(string)
	packID := pack["id"].(string)
	if !strings.HasPrefix(ref, "asset:"+shared+":") || entry["sha256"] == "" || entry["sourceSha256"] == "" {
		t.Fatal("missing asset provenance", entry)
	}
	listed := owner.object("GET", spacePath+"/icon-packs", nil, 200)
	if len(listed["packs"].([]any)) != 1 {
		t.Fatal("pack listing did not persist")
	}
	imageResponse := owner.request("GET", assetURL, nil, nil)
	if imageResponse.Code != 200 || imageResponse.Header().Get("Content-Type") != "image/svg+xml" || imageResponse.Header().Get("Cache-Control") != "private, no-cache" || imageResponse.Header().Get("ETag") != `"`+entry["sha256"].(string)+`"` || imageResponse.Header().Get("Vary") != "Cookie, Authorization" || !strings.Contains(imageResponse.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatal("asset response policy failed", imageResponse.Code, imageResponse.Header())
	}
	validatedResponse := owner.request("GET", assetURL, nil, http.Header{"If-None-Match": []string{imageResponse.Header().Get("ETag")}})
	if validatedResponse.Code != http.StatusNotModified || validatedResponse.Body.Len() != 0 || validatedResponse.Header().Get("Cache-Control") != "private, no-cache" {
		t.Fatal("stored icon did not revalidate without a response body", validatedResponse.Code, validatedResponse.Header(), validatedResponse.Body)
	}
	category := owner.object("POST", spacePath+"/categories", map[string]any{"name": "Custom icons", "icon": ref, "sortOrder": 0}, 201)
	linkInput := coreLink("Custom icon bookmark", "https://example.org/path")
	linkInput["icon"] = ref
	linkInput["categoryId"] = category["id"]
	link := owner.object("POST", spacePath+"/links", linkInput, 201)
	owner.object("DELETE", spacePath+"/icon-packs/"+packID, nil, 409)
	// Icon endpoints reuse existing scoped tokens, including explicit denial of
	// read-only tokens and tokens for a different space.
	readToken := owner.object("POST", "/integrations/tokens", map[string]any{"name": "Read icons", "spaceId": shared, "actions": []string{"navigation:read"}, "expiresAt": time.Now().UTC().Add(time.Hour)}, 201)["token"].(string)
	sharedToken := owner.object("POST", "/integrations/tokens", map[string]any{"name": "Manage shared bookmarks", "spaceId": shared, "actions": []string{"navigation:read", "navigation:write"}, "expiresAt": time.Now().UTC().Add(time.Hour)}, 201)["token"].(string)
	writeToken := owner.object("POST", "/integrations/tokens", map[string]any{"name": "Write own icons", "spaceId": personal, "actions": []string{"navigation:write"}, "expiresAt": time.Now().UTC().Add(time.Hour)}, 201)["token"].(string)
	if w := owner.request("POST", "/api/v1"+spacePath+"/icon-packs", iconPackFixture(), http.Header{"Authorization": []string{"Bearer " + readToken}}); w.Code != 403 {
		t.Fatal("read-only token imported an icon pack", w.Code)
	}
	if w := owner.request("POST", "/api/v1"+spacePath+"/icon-packs", iconPackFixture(), http.Header{"Authorization": []string{"Bearer " + writeToken}}); w.Code != 404 {
		t.Fatal("token crossed its space boundary", w.Code)
	}
	if w := owner.request("GET", assetURL, nil, http.Header{"Authorization": []string{"Bearer " + readToken}}); w.Code != 200 {
		t.Fatal("authorized read token cannot read the icon", w.Code)
	}
	// Asset references are 103 characters; the MCP schema and the shared
	// navigation validator must accept exactly the same persisted reference.
	mcpWrite := owner.request("POST", "/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "bookmarks_update", "arguments": map[string]any{"spaceId": shared, "id": link["id"], "input": linkInput}}}, http.Header{"Authorization": []string{"Bearer " + sharedToken}, "Accept": []string{"application/json, text/event-stream"}, "Mcp-Protocol-Version": []string{"2025-11-25"}})
	var mcpResult map[string]any
	if err = json.Unmarshal(mcpWrite.Body.Bytes(), &mcpResult); err != nil || mcpWrite.Code != 200 {
		t.Fatalf("MCP icon update failed: %d %s", mcpWrite.Code, mcpWrite.Body)
	}
	toolResult, _ := mcpResult["result"].(map[string]any)
	structured, _ := toolResult["structuredContent"].(map[string]any)
	if toolResult["isError"] == true || structured["icon"] != ref {
		t.Fatalf("MCP rejected stored custom icon: %s", mcpWrite.Body)
	}
	wrong := coreLink("Cross-space icon", "https://example.org/other")
	wrong["icon"] = ref
	owner.object("POST", "/spaces/"+personal+"/links", wrong, 400)
	wrong["icon"] = "asset:" + personal + ":" + strings.Repeat("a", 64)
	owner.object("POST", "/spaces/"+personal+"/links", wrong, 400)
	badPack := iconPackFixture()
	badPack["name"] = "Bad atomic pack"
	badPack["icons"].([]any)[0].(map[string]any)["dataBase64"] = base64.StdEncoding.EncodeToString([]byte(strings.ReplaceAll(iconFixtureSVG, "currentColor", "#2266aa")))
	badPack["icons"] = append(badPack["icons"].([]any), map[string]any{"key": "evil", "label": "Evil", "mediaType": "image/svg+xml", "dataBase64": base64.StdEncoding.EncodeToString([]byte(`<svg viewBox="0 0 24 24" onload="x()"/>`))})
	owner.object("POST", spacePath+"/icon-packs", badPack, 400)
	listed = owner.object("GET", spacePath+"/icon-packs", nil, 200)
	if len(listed["packs"].([]any)) != 1 {
		t.Fatal("failed import left a partial pack")
	}
	var assetCount int
	if err = a.store.DB.QueryRowContext(context.Background(), a.store.Query("SELECT COUNT(*) FROM icon_assets WHERE space_id=?"), shared).Scan(&assetCount); err != nil || assetCount != 1 {
		t.Fatal("failed import left orphaned image bytes", assetCount, err)
	}
	owner.object("POST", "/admin/users", map[string]any{"username": "icon-member", "displayName": "Icon member", "password": "icon-fixture-member-2026"}, 201)
	member := newIconHTTPBrowser(t, a)
	member.bootstrap()
	member.object("POST", "/auth/login", map[string]any{"username": "icon-member", "password": "icon-fixture-member-2026"}, 200)
	memberBoot := member.bootstrap()
	memberSpace := coreSpace(memberBoot, "personal")
	member.object("POST", spacePath+"/icon-packs", iconPackFixture(), 403)
	member.object("GET", "/spaces/"+personal+"/icon-packs", nil, 404)
	memberPack := member.object("POST", "/spaces/"+memberSpace+"/icon-packs", iconPackFixture(), 201)
	memberImage := memberPack["icons"].([]any)[0].(map[string]any)["url"].(string)
	if owner.request("GET", memberImage, nil, nil).Code != 404 {
		t.Fatal("owner read another member's personal icon")
	}
	if member.request("GET", assetURL, nil, nil).Code != 200 {
		t.Fatal("signed-in member cannot read shared icon")
	}
	anonymous := newIconHTTPBrowser(t, a)
	anonymous.bootstrap()
	if anonymous.request("GET", assetURL, nil, nil).Code != 401 {
		t.Fatal("private icon leaked to anonymous viewer")
	}
	owner.object("PUT", "/settings", map[string]any{"siteName": "Icon fixture", "mode": "public_read", "registrationEnabled": false}, 200)
	owner.bootstrap()
	owner.object("POST", "/auth/login", map[string]any{"username": "icon-owner", "password": "icon-fixture-owner-2026"}, 200)
	owner.bootstrap()
	owner.object("PUT", spacePath, map[string]any{"name": "Shared icon fixture", "published": true}, 200)
	anonymous.bootstrap()
	if anonymous.request("GET", assetURL, nil, nil).Code != 200 {
		t.Fatal("published icon not available to public viewer")
	}
	anonymous.object("POST", spacePath+"/icon-packs", iconPackFixture(), 401)
	if w := owner.request("POST", "/api/v1"+spacePath+"/icon-packs", iconPackFixture(), http.Header{"X-Csrf-Token": []string{"invalid"}}); w.Code != 403 {
		t.Fatalf("invalid CSRF accepted: %d %s", w.Code, w.Body)
	}
	owner.object("PUT", "/settings", map[string]any{"siteName": "Icon fixture", "mode": "open_edit", "registrationEnabled": false}, 200)
	owner.bootstrap()
	anonymous.bootstrap()
	openPack := anonymous.object("POST", spacePath+"/icon-packs", iconPackFixture(), 201)
	// A duplicate pack shares bytes; removing one owner must retain live icons.
	anonymous.object("DELETE", spacePath+"/icon-packs/"+openPack["id"].(string), nil, 204)
	if anonymous.request("GET", assetURL, nil, nil).Code != 200 {
		t.Fatal("deduplicated pack removal broke remaining icon")
	}
	if w := anonymous.request("POST", "/api/v1"+spacePath+"/icon-packs", iconPackFixture(), http.Header{"Authorization": []string{"", "Bearer invalid"}}); w.Code != 401 {
		t.Fatal("duplicate Authorization fell back to anonymous editing")
	}
	// Restore link/category builtins, then exercise source snapshot references.
	linkInput["icon"] = "lucide:link"
	anonymous.object("PUT", spacePath+"/links/"+link["id"].(string), linkInput, 200)
	anonymous.object("PUT", spacePath+"/categories/"+category["id"].(string), map[string]any{"name": "Custom icons", "icon": "lucide:folder", "sortOrder": 0}, 200)
	owner.object("POST", "/auth/login", map[string]any{"username": "icon-owner", "password": "icon-fixture-owner-2026"}, 200)
	owner.bootstrap()
	source := owner.object("POST", spacePath+"/sources", map[string]any{"name": "Icon source fixture", "kind": "external-push", "schemaId": "navigation.collection", "schemaVersion": 1, "connection": map[string]string{}, "sync": map[string]any{"mode": "push", "staleAfterSeconds": 3600}, "enabled": true}, 201)
	snapshotPath := "/sources/" + source["id"].(string) + "/snapshot"
	snapshot := integrationSnapshot("icons-first", "0", nil)
	snapshotData := snapshot["data"].(map[string]any)
	snapshotData["categories"].([]any)[0].(map[string]any)["icon"] = ref
	snapshotData["links"].([]any)[0].(map[string]any)["icon"] = ref
	owner.object("PUT", snapshotPath, snapshot, 200)
	anonymous.object("DELETE", spacePath+"/icon-packs/"+packID, nil, 409)
	snapshot["requestId"] = "icons-second"
	snapshot["expectedRevision"] = "1"
	snapshotData["categories"].([]any)[0].(map[string]any)["icon"] = "asset:" + personal + ":" + entry["sha256"].(string)
	owner.object("PUT", snapshotPath, snapshot, 400)
	snapshotData["categories"].([]any)[0].(map[string]any)["icon"] = "lucide:folder"
	snapshotData["links"].([]any)[0].(map[string]any)["icon"] = "lucide:link"
	owner.object("PUT", snapshotPath, snapshot, 200)
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	a, err = Open(c)
	if err != nil {
		t.Fatal(err)
	}
	owner.a = a
	anonymous.a = a
	member.a = a
	anonymous.bootstrap()
	if anonymous.request("GET", assetURL, nil, nil).Code != 200 {
		t.Fatal("custom icon did not survive restart")
	}
	anonymous.object("DELETE", spacePath+"/icon-packs/"+packID, nil, 204)
	if anonymous.request("GET", assetURL, nil, nil).Code != 404 {
		t.Fatal("unreferenced deleted icon remains exposed")
	}
	// Main navigation remains intact; only explicit test CRUD changed icons.
	navigation := anonymous.object("GET", spacePath+"/navigation", nil, 200)["data"].(map[string]any)
	if len(navigation["links"].([]any)) != 1 || len(navigation["categories"].([]any)) != 1 {
		t.Fatal("icon operations modified navigation collections")
	}
}

func TestIconFetchHTTPAuthorizationCacheAndRecheck(t *testing.T) {
	c := coreConfig(t, false)
	a, err := Open(c)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b := newIconHTTPBrowser(t, a)
	b.bootstrap()
	b.object("POST", "/setup", map[string]any{"siteName": "Fetch fixture", "mode": "open_edit", "seedDemo": false}, 201)
	boot := b.bootstrap()
	space := coreSpace(boot, "shared")
	path := "/spaces/" + space + "/icons/fetch"
	pngBytes := testIconPNG(t, 16, 16)
	var count atomic.Int32
	a.iconHTTPClient = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		count.Add(1)
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(bytes.NewReader(pngBytes))}, nil
	})}
	if w := b.request("POST", "/api/v1"+path, map[string]any{"url": "https://example.org/x"}, http.Header{"X-Csrf-Token": []string{"bad"}}); w.Code != 403 || count.Load() != 0 {
		t.Fatal("fetch happened before CSRF check", w.Code, count.Load())
	}
	result := b.object("POST", path, map[string]any{"url": "https://example.org/private?token=secret"}, 200)
	if result["cached"] != false || count.Load() != 1 {
		t.Fatal("first explicit fetch failed", result, count.Load())
	}
	second := b.object("POST", path, map[string]any{"url": "https://example.org/other"}, 200)
	if second["cached"] != true || second["ref"] != result["ref"] || count.Load() != 1 {
		t.Fatal("origin cache missed", second, count.Load())
	}
	for i := 0; i < 3; i++ {
		if w := b.request("GET", result["url"].(string), nil, nil); w.Code != 200 {
			t.Fatal(w.Code)
		}
	}
	if count.Load() != 1 {
		t.Fatal("visitor image GET triggered upstream fetch")
	}
	b.object("POST", path, map[string]any{"url": "http://127.0.0.1/"}, 400)
	if count.Load() != 1 {
		t.Fatal("local URL performed an upstream request")
	}
	a.iconFetchGate <- struct{}{}
	b.object("POST", path, map[string]any{"url": "https://busy.example.org/"}, 429)
	<-a.iconFetchGate
	if count.Load() != 1 {
		t.Fatal("concurrent fetch limit performed a remote request")
	}
	a.iconHTTPClient = &http.Client{Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		count.Add(1)
		return nil, errors.New("fixture unavailable")
	})}
	b.object("POST", path, map[string]any{"url": "https://missing.example.org/"}, 422)
	firstFail := count.Load()
	b.object("POST", path, map[string]any{"url": "https://missing.example.org/second"}, 422)
	if count.Load() != firstFail {
		t.Fatal("negative cache repeated remote requests")
	}
	if _, err = a.store.DB.ExecContext(context.Background(), a.store.Query("UPDATE icon_favicon_cache SET retry_at=? WHERE space_id=? AND origin=?"), time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano), space, "https://example.org/"); err != nil {
		t.Fatal(err)
	}
	stale := b.object("POST", path, map[string]any{"url": "https://example.org/"}, 200)
	if stale["ref"] != result["ref"] || stale["cached"] != true || stale["stale"] != true {
		t.Fatal("failed refresh discarded previous icon", stale)
	}
	staleCount := count.Load()
	b.object("POST", path, map[string]any{"url": "https://example.org/"}, 200)
	if count.Load() != staleCount {
		t.Fatal("failed refresh ignored retry cache")
	}
	// A mode change in the middle of network work must not permit the original
	// anonymous maintenance to cache a result after access has been revoked.
	a.iconHTTPClient = &http.Client{Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) {
		_, e := a.store.DB.ExecContext(context.Background(), "UPDATE settings SET mode='private_single',auth_epoch=auth_epoch+1 WHERE id=1")
		if e != nil {
			t.Fatal(e)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(bytes.NewReader(pngBytes))}, nil
	})}
	w := b.request("POST", "/api/v1"+path, map[string]any{"url": "https://change.example.org/"}, nil)
	if w.Code != 403 && w.Code != 401 {
		t.Fatalf("stale authorization cached result: %d %s", w.Code, w.Body)
	}
	var saved int
	if err = a.store.DB.QueryRowContext(context.Background(), a.store.Query("SELECT COUNT(*) FROM icon_favicon_cache WHERE origin=?"), "https://change.example.org/").Scan(&saved); err != nil {
		t.Fatal(err)
	}
	if saved != 0 {
		t.Fatal("revoked request persisted cache state")
	}
}

func TestIconFetchContextDeadline(t *testing.T) {
	client := &http.Client{Transport: integrationRoundTrip(func(r *http.Request) (*http.Response, error) { <-r.Context().Done(); return nil, r.Context().Err() })}
	origin, _ := url.Parse("https://example.org/")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, _, err := fetchWebsiteIcon(ctx, client, origin); err == nil {
		t.Fatal("cancelled fetch succeeded")
	}
	if time.Since(start) > time.Second {
		t.Fatal("request deadline was not honored")
	}
}
