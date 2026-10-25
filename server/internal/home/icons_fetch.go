package home

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/html"
)

const (
	iconFetchTimeout     = 10 * time.Second
	iconHeadTimeout      = 3 * time.Second
	iconFallbackTime     = 2 * time.Second
	iconHeadMaxBytes     = 512 << 10
	iconFetchMaxBytes    = 1 << 20
	iconFetchMaxRequests = 6
)

var iconBlockedNetworks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("224.0.0.0/4"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001::/23"), netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("3ffe::/16"), netip.MustParsePrefix("3fff::/20"),
}

func iconPublicIP(ip netip.Addr) bool {
	if ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	if !ip.IsValid() || ip.Zone() != "" || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	// IPv6 transition, mapped and local address families cannot turn an allowed
	// name into a connection to a non-public IPv4 target.
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, block := range iconBlockedNetworks {
		if block.Contains(ip) {
			return false
		}
	}
	return true
}

func iconRemoteURL(raw string) (*url.URL, error) {
	canonical, err := canonicalURL(raw)
	if err != nil {
		return nil, err
	}
	// Reuse the source fetcher's bounded RFC1918/ULA policy and hostname
	// validation. Canonicalizing first keeps bookmark fragments ignorable;
	// iconWebsiteOrigin separately strips bookmark paths and queries.
	u, err := integrationRemoteURL(canonical, true)
	if err != nil {
		return nil, invalid("Website address is blocked or invalid.")
	}
	return u, nil
}

type iconInitialHostKey struct{}

func iconScopeHost(host string) string {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if ip, err := netip.ParseAddr(host); err == nil {
		return ip.Unmap().String()
	}
	return host
}

// Only the hostname initially selected by the editor may resolve to private
// addresses. Redirects, HTML candidates and nested template discovery retain
// this scope; changing scheme or port on that same host is allowed.
func iconNetworkContext(ctx context.Context, initial *url.URL) context.Context {
	if _, exists := ctx.Value(iconInitialHostKey{}).(string); exists {
		return ctx
	}
	return context.WithValue(ctx, iconInitialHostKey{}, iconScopeHost(initial.Hostname()))
}

func iconPrivateTarget(ctx context.Context, host string) bool {
	initial, _ := ctx.Value(iconInitialHostKey{}).(string)
	return initial != "" && initial == iconScopeHost(host)
}

func iconScopedRemoteURL(ctx context.Context, raw string) (*url.URL, error) {
	target, err := iconRemoteURL(raw)
	if err != nil {
		return nil, err
	}
	if iconPrivateTarget(ctx, target.Hostname()) {
		return target, nil
	}
	// Literal addresses and local names are rejected here as well as in Dial,
	// so a transport that does not dial cannot bypass the URL-level boundary.
	target, err = integrationRemoteURL(target.String(), false)
	if err != nil {
		return nil, invalid("Only the original website hostname may use a private network address.")
	}
	return target, nil
}

// The user supplies a bookmark URL; only its canonical origin is requested.
// Its private path, query parameters and fragment never leave Home.
func iconWebsiteOrigin(raw string) (*url.URL, error) {
	u, err := iconRemoteURL(raw)
	if err != nil {
		return nil, err
	}
	u.Path, u.RawPath, u.RawQuery, u.ForceQuery = "/", "", "", false
	return u, nil
}

type iconIPResolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}
type iconDialContext func(context.Context, string, string) (net.Conn, error)

func iconPinnedDial(resolver iconIPResolver, dial iconDialContext) iconDialContext {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" && network != "tcp4" && network != "tcp6" {
			return nil, errors.New("unsupported icon network")
		}
		host, port, err := net.SplitHostPort(address)
		number, portErr := strconv.Atoi(port)
		if err != nil || portErr != nil || number < 1 || number > 65535 {
			return nil, errors.New("unsupported icon port")
		}
		// Every DNS result is checked before any socket is opened, then the
		// existing direct/proxy adapter receives only a validated IP literal.
		return integrationPinnedDial(resolver, dial, iconPrivateTarget(ctx, host))(ctx, network, address)
	}
}

func newIconHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: -1}
	return newIconHTTPClientWithDial(dialer.DialContext)
}

func newIconHTTPClientWithDial(dial iconDialContext) *http.Client {
	transport := &http.Transport{
		Proxy: nil, DialContext: iconPinnedDial(net.DefaultResolver, dial),
		DisableKeepAlives: true, DisableCompression: true, TLSHandshakeTimeout: 3 * time.Second,
		ResponseHeaderTimeout: 3 * time.Second, MaxResponseHeaderBytes: 32 << 10,
	}
	return &http.Client{Transport: transport, Timeout: iconFetchTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

type iconFetchBudget struct {
	requests int
	bytes    int
}

type iconDocumentPolicy struct {
	maxBytes    int
	htmlHead    bool
	maxRequests int
	totalBytes  int
}

func fetchIconDocument(ctx context.Context, client *http.Client, target *url.URL, budget *iconFetchBudget, maxBytes int) ([]byte, string, *url.URL, error) {
	return fetchIconResponse(ctx, client, target, budget, iconDocumentPolicy{maxBytes: maxBytes})
}

// HTML is only a source of icon hints. Reading through a slow page body is not
// needed once its head has ended, and a large declared length is not a reason
// to discard a bounded, complete link tag near the start of the document.
func readIconHTMLHead(reader io.Reader, limit int) []byte {
	var prefix bytes.Buffer
	z := html.NewTokenizer(io.TeeReader(io.LimitReader(reader, int64(limit)), &prefix))
	for tokens := 0; tokens < 4096; tokens++ {
		kind := z.Next()
		if kind == html.ErrorToken {
			// Complete tags in a bounded prefix remain usable if the page ends or
			// the head subdeadline interrupts it. This HTML is never served.
			break
		}
		if kind == html.EndTagToken || kind == html.StartTagToken || kind == html.SelfClosingTagToken {
			name, _ := z.TagName()
			if kind == html.EndTagToken && string(name) == "head" || kind != html.EndTagToken && string(name) == "body" {
				break
			}
		}
	}
	return prefix.Bytes()
}

func fetchIconResponse(ctx context.Context, client *http.Client, target *url.URL, budget *iconFetchBudget, policy iconDocumentPolicy) ([]byte, string, *url.URL, error) {
	if policy.maxRequests <= 0 || policy.maxRequests > iconFetchMaxRequests {
		policy.maxRequests = iconFetchMaxRequests
	}
	if policy.totalBytes <= 0 || policy.totalBytes > iconFetchMaxBytes {
		policy.totalBytes = iconFetchMaxBytes
	}
	current := target
	for redirects := 0; redirects <= 3; redirects++ {
		checked, err := iconScopedRemoteURL(ctx, current.String())
		if err != nil {
			return nil, "", nil, err
		}
		if budget.requests >= policy.maxRequests || budget.bytes >= policy.totalBytes {
			return nil, "", nil, errors.New("website icon request limit reached")
		}
		budget.requests++
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, checked.String(), nil)
		if err != nil {
			return nil, "", nil, err
		}
		request.Header.Set("Accept", "text/html,image/png,image/jpeg,image/svg+xml,image/x-icon,image/vnd.microsoft.icon;q=0.9")
		request.Header.Set("User-Agent", "Lingshu-Home/website-icon")
		response, err := client.Do(request)
		if err != nil {
			return nil, "", nil, errors.New("website icon request failed")
		}
		if response.StatusCode == 301 || response.StatusCode == 302 || response.StatusCode == 303 || response.StatusCode == 307 || response.StatusCode == 308 {
			location := response.Header.Get("Location")
			response.Body.Close()
			next, err := url.Parse(location)
			if err != nil || location == "" || redirects == 3 {
				return nil, "", nil, errors.New("website icon redirect limit reached")
			}
			current = checked.ResolveReference(next)
			continue
		}
		if response.StatusCode != http.StatusOK || response.Header.Get("Content-Encoding") != "" {
			response.Body.Close()
			return nil, "", nil, errors.New("website icon returned an unsupported response")
		}
		mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
		remaining := policy.totalBytes - budget.bytes
		if policy.htmlHead && (mediaType == "text/html" || mediaType == "application/xhtml+xml") {
			body := readIconHTMLHead(response.Body, min(policy.maxBytes, remaining))
			response.Body.Close()
			budget.bytes += len(body)
			if len(body) == 0 {
				return nil, "", nil, errors.New("website icon page head is unavailable")
			}
			return body, mediaType, checked, nil
		}
		// An origin may itself return an image. Prefix acceptance applies only
		// to HTML/XHTML, never to an image or an unknown response format.
		maxBytes := policy.maxBytes
		if policy.htmlHead {
			maxBytes = min(maxBytes, iconMaxBytes)
		}
		if response.ContentLength > int64(maxBytes) || response.ContentLength > int64(remaining) {
			response.Body.Close()
			return nil, "", nil, errors.New("website icon returned an unsupported response")
		}
		readLimit := min(maxBytes+1, remaining)
		body, err := io.ReadAll(io.LimitReader(response.Body, int64(readLimit)))
		response.Body.Close()
		budget.bytes += len(body)
		// At the total budget boundary, an unknown-length image cannot be
		// assumed complete without another byte. Reject it without reading past
		// the budget. A known complete Content-Length needs no extra read.
		limited := len(body) == readLimit && readLimit <= maxBytes && response.ContentLength != int64(len(body))
		truncated := response.ContentLength > 0 && int64(len(body)) != response.ContentLength
		if err != nil || len(body) == 0 || len(body) > maxBytes || limited || truncated {
			return nil, "", nil, errors.New("website icon response is too large")
		}
		return body, mediaType, checked, nil
	}
	return nil, "", nil, errors.New("website icon redirect limit reached")
}

func iconHTMLCandidates(body []byte, page *url.URL) []*url.URL {
	return scopedIconHTMLCandidates(iconNetworkContext(context.Background(), page), body, page)
}

func scopedIconHTMLCandidates(ctx context.Context, body []byte, page *url.URL) []*url.URL {
	result := []*url.URL{}
	seen := map[string]bool{}
	z := html.NewTokenizer(bytes.NewReader(body))
	for tokens := 0; tokens < 4096 && len(result) < 3; tokens++ {
		typeOf := z.Next()
		if typeOf == html.ErrorToken {
			break
		}
		if typeOf == html.EndTagToken {
			name, _ := z.TagName()
			if string(name) == "head" {
				break
			}
		}
		if typeOf != html.StartTagToken && typeOf != html.SelfClosingTagToken {
			continue
		}
		token := z.Token()
		if token.Data == "body" {
			break
		}
		if token.Data != "link" {
			continue
		}
		rel, href := "", ""
		for _, attr := range token.Attr {
			if attr.Key == "rel" {
				rel = attr.Val
			}
			if attr.Key == "href" {
				href = attr.Val
			}
		}
		accepted := false
		for _, value := range strings.Fields(strings.ToLower(rel)) {
			if value == "icon" || value == "apple-touch-icon" {
				accepted = true
			}
		}
		if !accepted || href == "" || len(href) > 4096 {
			continue
		}
		u, err := url.Parse(href)
		if err != nil {
			continue
		}
		u, err = iconScopedRemoteURL(ctx, page.ResolveReference(u).String())
		if err != nil || seen[u.String()] {
			continue
		}
		seen[u.String()] = true
		result = append(result, u)
	}
	return result
}

func fetchWebsiteIcon(ctx context.Context, client *http.Client, origin *url.URL) (normalizedIcon, string, error) {
	ctx = iconNetworkContext(ctx, origin)
	ctx, cancel := context.WithTimeout(ctx, iconFetchTimeout)
	defer cancel()
	budget := &iconFetchBudget{}
	candidates := []*url.URL{}
	headContext, cancelHead := context.WithTimeout(ctx, iconHeadTimeout)
	body, mediaType, page, err := fetchIconResponse(headContext, client, origin, budget, iconDocumentPolicy{maxBytes: iconHeadMaxBytes, htmlHead: true})
	cancelHead()
	if err == nil {
		if strings.HasPrefix(mediaType, "image/") {
			icon, err := normalizeFetchedIcon(body, mediaType)
			if err == nil {
				return icon, page.String(), nil
			}
		} else if mediaType == "text/html" || mediaType == "application/xhtml+xml" {
			candidates = scopedIconHTMLCandidates(ctx, body, page)
		}
	}
	if page == nil {
		page = origin
	}
	fallback := *page
	fallback.Path, fallback.RawPath, fallback.RawQuery, fallback.Fragment = "/favicon.ico", "", "", ""
	// Keep time, one request and one maximum image body available for the
	// conventional fallback even if declared candidates are slow or invalid.
	deadline, _ := ctx.Deadline()
	candidateContext, cancelCandidates := context.WithDeadline(ctx, deadline.Add(-iconFallbackTime))
	candidatePolicy := iconDocumentPolicy{maxBytes: iconMaxBytes, maxRequests: iconFetchMaxRequests - 1, totalBytes: iconFetchMaxBytes - iconMaxBytes}
	for _, target := range candidates {
		if candidateContext.Err() != nil || budget.requests >= candidatePolicy.maxRequests || budget.bytes >= candidatePolicy.totalBytes {
			break
		}
		body, kind, location, err := fetchIconResponse(candidateContext, client, target, budget, candidatePolicy)
		if err != nil {
			continue
		}
		icon, err := normalizeFetchedIcon(body, kind)
		if err == nil {
			cancelCandidates()
			return icon, location.String(), nil
		}
	}
	cancelCandidates()
	if ctx.Err() == nil && budget.requests < iconFetchMaxRequests && budget.bytes < iconFetchMaxBytes {
		body, kind, location, err := fetchIconDocument(ctx, client, &fallback, budget, iconMaxBytes)
		if err == nil {
			icon, err := normalizeFetchedIcon(body, kind)
			if err == nil {
				return icon, location.String(), nil
			}
		}
	}
	return normalizedIcon{}, "", &APIError{Status: 422, Code: "favicon_unavailable", Message: "No supported website icon was found. Choose a built-in icon or import an image."}
}

func normalizeFetchedIcon(body []byte, mediaType string) (normalizedIcon, error) {
	if len(body) > iconMaxBytes {
		return normalizedIcon{}, errors.New("icon too large")
	}
	// ICO entries are decoded and rewritten as PNG. Only bounded PNG or
	// uncompressed 24/32-bit DIB entries are accepted; nothing is served raw.
	if len(body) >= 6 && bytes.Equal(body[:4], []byte{0, 0, 1, 0}) {
		converted, err := iconICOToPNG(body)
		if err != nil {
			return normalizedIcon{}, err
		}
		return normalizeIcon(converted, "image/png")
	}
	if mediaType == "image/x-icon" || mediaType == "image/vnd.microsoft.icon" || mediaType == "application/octet-stream" || mediaType == "" {
		mediaType = http.DetectContentType(body)
	}
	return normalizeIcon(body, mediaType)
}

func iconICOToPNG(body []byte) ([]byte, error) {
	if len(body) < 6 || len(body) > iconMaxBytes || !bytes.Equal(body[:4], []byte{0, 0, 1, 0}) {
		return nil, errors.New("invalid ICO")
	}
	count := int(binary.LittleEndian.Uint16(body[4:6]))
	if count < 1 || count > 32 || len(body) < 6+16*count {
		return nil, errors.New("invalid ICO directory")
	}
	type entry struct{ w, h, offset, size int }
	entries := []entry{}
	for i := 0; i < count; i++ {
		p := body[6+i*16 : 6+(i+1)*16]
		w, h := int(p[0]), int(p[1])
		if w == 0 {
			w = 256
		}
		if h == 0 {
			h = 256
		}
		size, offset := uint64(binary.LittleEndian.Uint32(p[8:12])), uint64(binary.LittleEndian.Uint32(p[12:16]))
		if size == 0 || offset < uint64(6+16*count) || offset+size > uint64(len(body)) {
			return nil, errors.New("invalid ICO bounds")
		}
		entries = append(entries, entry{w, h, int(offset), int(size)})
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].w*entries[i].h > entries[j].w*entries[j].h })
	for _, item := range entries {
		content := body[item.offset : item.offset+item.size]
		if bytes.HasPrefix(content, []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
			config, err := png.DecodeConfig(bytes.NewReader(content))
			if err == nil && config.Width == item.w && config.Height == item.h {
				return content, nil
			}
			continue
		}
		decoded, err := iconDecodeDIB(content, item.w, item.h)
		if err != nil {
			continue
		}
		var result bytes.Buffer
		if err = png.Encode(&result, decoded); err == nil {
			return result.Bytes(), nil
		}
	}
	return nil, errors.New("ICO has no supported PNG or 24/32-bit image")
}

func iconDecodeDIB(body []byte, width, height int) (image.Image, error) {
	if len(body) < 40 || binary.LittleEndian.Uint32(body[:4]) != 40 || int32(binary.LittleEndian.Uint32(body[4:8])) != int32(width) || int32(binary.LittleEndian.Uint32(body[8:12])) != int32(height*2) || binary.LittleEndian.Uint16(body[12:14]) != 1 || binary.LittleEndian.Uint32(body[16:20]) != 0 {
		return nil, errors.New("unsupported ICO DIB")
	}
	bits := int(binary.LittleEndian.Uint16(body[14:16]))
	if bits != 24 && bits != 32 {
		return nil, fmt.Errorf("unsupported ICO depth %d", bits)
	}
	rowBytes := ((width*bits + 31) / 32) * 4
	maskBytes := ((width + 31) / 32) * 4
	maskOffset := 40 + rowBytes*height
	if len(body) < maskOffset+maskBytes*height {
		return nil, errors.New("truncated ICO DIB")
	}
	out := image.NewNRGBA(image.Rect(0, 0, width, height))
	hasAlpha := false
	if bits == 32 {
		for y := 0; y < height; y++ {
			for x := 0; x < width; x++ {
				if body[40+y*rowBytes+x*4+3] != 0 {
					hasAlpha = true
				}
			}
		}
	}
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			index := 40 + (height-1-y)*rowBytes + x*(bits/8)
			a := uint8(255)
			if bits == 32 && hasAlpha {
				a = body[index+3]
			}
			mask := body[maskOffset+(height-1-y)*maskBytes+x/8]
			if mask&(1<<uint(7-x%8)) != 0 {
				a = 0
			}
			out.SetNRGBA(x, y, color.NRGBA{R: body[index+2], G: body[index+1], B: body[index], A: a})
		}
	}
	return out, nil
}
