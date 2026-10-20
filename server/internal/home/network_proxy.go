package home

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/idna"
)

// NetworkProxyConfig is the complete public projection. Even Owners cannot
// retrieve a saved username or password through this API.
type NetworkProxyConfig struct {
	Revision             string `json:"revision"`
	Mode                 string `json:"mode"`
	URL                  string `json:"url"`
	CredentialConfigured bool   `json:"credentialConfigured"`
}

type networkProxySecret struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type networkProxyRuntime struct {
	config   NetworkProxyConfig
	revision int64
	endpoint *url.URL
	secret   networkProxySecret
	cipher   string
}

type networkProxyGeneration struct {
	runtime *networkProxyRuntime
	ctx     context.Context
	cancel  context.CancelCauseFunc
}

type networkProxyManager struct {
	mu      sync.RWMutex
	current networkProxyGeneration
}

type networkProxyOperationKey struct{}
type networkProxyOperation struct {
	runtime    *networkProxyRuntime
	generation context.Context
}

var errNetworkProxyChanged = errors.New("outbound proxy configuration changed")

func networkProxyChanged() error {
	return &APIError{Status: http.StatusConflict, Code: "network_proxy_changed", Message: "The outbound proxy configuration changed during this request. Retry the operation."}
}

func networkProxyURL(raw string) (*url.URL, error) {
	if raw == "" {
		return nil, nil
	}
	if len(raw) > 2048 || !utf8.ValidString(raw) || strings.ContainsFunc(raw, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) || strings.ContainsAny(raw, "\\%") {
		return nil, invalid("Use an HTTP, HTTPS or SOCKS5 proxy URL with an explicit port and no embedded credentials or path.")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#") || (u.Path != "" && u.Path != "/") {
		return nil, invalid("Proxy URL must not contain credentials, a path, query or fragment.")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if !oneOf(u.Scheme, "http", "https", "socks5") {
		return nil, invalid("Supported outbound proxy schemes are http, https and socks5.")
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if ip, err := netip.ParseAddr(host); err == nil {
		if !networkProxyAddressAllowed(ip) {
			return nil, invalid("The proxy address is reserved, link-local or a metadata endpoint.")
		}
		host = ip.Unmap().String()
	} else {
		host, err = idna.Lookup.ToASCII(host)
		if err != nil || host == "" || len(host) > 253 {
			return nil, invalid("Invalid proxy hostname.")
		}
		for _, label := range strings.Split(host, ".") {
			if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return nil, invalid("Invalid proxy hostname.")
			}
			for _, ch := range label {
				if ch != '-' && (ch < 'a' || ch > 'z') && (ch < '0' || ch > '9') {
					return nil, invalid("Invalid proxy hostname.")
				}
			}
		}
		for _, blocked := range []string{"metadata", "metadata.google.internal", "instance-data", "metadata.tencentyun.com"} {
			if host == blocked || strings.HasSuffix(host, "."+blocked) {
				return nil, invalid("A metadata hostname cannot be used as a proxy.")
			}
		}
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, invalid("Specify a proxy port between 1 and 65535.")
	}
	return &url.URL{Scheme: u.Scheme, Host: net.JoinHostPort(host, strconv.Itoa(port))}, nil
}

func validateNetworkProxySecret(secret networkProxySecret) error {
	for _, value := range []string{secret.Username, secret.Password} {
		if len(value) < 1 || len(value) > 255 || !utf8.ValidString(value) || strings.ContainsFunc(value, unicode.IsControl) {
			return invalid("Proxy username and password must each contain 1–255 UTF-8 bytes without control characters.")
		}
	}
	if strings.Contains(secret.Username, ":") {
		return invalid("A proxy username cannot contain a colon.")
	}
	return nil
}

func (a *App) encryptNetworkProxySecret(secret networkProxySecret) (string, error) {
	aead, err := a.integrationAEAD()
	if err != nil {
		return "", err
	}
	plain, err := json.Marshal(secret)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	blob := aead.Seal(nonce, nonce, plain, []byte("Lingshu-Home/network-proxy/v1"))
	return base64.RawStdEncoding.EncodeToString(blob), nil
}

func (a *App) decryptNetworkProxySecret(ciphertext string) (networkProxySecret, error) {
	var secret networkProxySecret
	aead, err := a.integrationAEAD()
	if err != nil {
		return secret, err
	}
	blob, err := base64.RawStdEncoding.DecodeString(ciphertext)
	if err != nil || len(blob) < aead.NonceSize()+aead.Overhead() {
		return secret, errors.New("saved proxy credentials are unavailable")
	}
	plain, err := aead.Open(nil, blob[:aead.NonceSize()], blob[aead.NonceSize():], []byte("Lingshu-Home/network-proxy/v1"))
	if err != nil || json.Unmarshal(plain, &secret) != nil || validateNetworkProxySecret(secret) != nil {
		return secret, errors.New("saved proxy credentials are unavailable")
	}
	return secret, nil
}

func (a *App) loadNetworkProxy(ctx context.Context, q Queryer) (*networkProxyRuntime, error) {
	runtime := &networkProxyRuntime{}
	var cipher sql.NullString
	err := q.QueryRowContext(ctx, "SELECT revision,mode,url,credential_cipher FROM network_proxy_config WHERE id=1").Scan(&runtime.revision, &runtime.config.Mode, &runtime.config.URL, &cipher)
	if err != nil {
		return nil, err
	}
	if runtime.revision < 1 || !oneOf(runtime.config.Mode, "direct", "proxy") {
		return nil, errors.New("saved proxy configuration is invalid")
	}
	runtime.endpoint, err = networkProxyURL(runtime.config.URL)
	if err != nil || runtime.config.Mode == "proxy" && runtime.endpoint == nil {
		return nil, errors.New("saved proxy configuration is invalid")
	}
	runtime.config.Revision = strconv.FormatInt(runtime.revision, 10)
	runtime.config.CredentialConfigured = cipher.Valid && cipher.String != ""
	runtime.cipher = cipher.String
	if runtime.config.CredentialConfigured {
		if runtime.endpoint == nil {
			return nil, errors.New("saved proxy configuration is invalid")
		}
		runtime.secret, err = a.decryptNetworkProxySecret(cipher.String)
		if err != nil {
			return nil, err
		}
	}
	return runtime, nil
}

func (a *App) initializeNetworkProxy() error {
	runtime, err := a.loadNetworkProxy(a.ctx, a.store.DB)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancelCause(a.ctx)
	a.networkProxy = &networkProxyManager{current: networkProxyGeneration{runtime: runtime, ctx: ctx, cancel: cancel}}
	return nil
}

func (a *App) registerNetworkProxyRoutes() {
	a.route("GET /api/v1/network-proxy", false, a.getNetworkProxy)
	a.route("PUT /api/v1/network-proxy", true, a.updateNetworkProxy)
}

func (a *App) getNetworkProxy(r *Request) (*Response, error) {
	if err := r.requireOwner(); err != nil {
		return nil, err
	}
	runtime, err := a.loadNetworkProxy(r.HTTP.Context(), r.Q)
	if err != nil {
		return nil, err
	}
	return ok(runtime.config), nil
}

type networkProxySecretInput struct {
	present bool
	value   networkProxySecret
}

func (s *networkProxySecretInput) UnmarshalJSON(raw []byte) error {
	var input struct {
		Username *string `json:"username"`
		Password *string `json:"password"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || input.Username == nil || input.Password == nil {
		return invalid("Supply both proxy username and password, or omit secret.")
	}
	s.present, s.value = true, networkProxySecret{Username: *input.Username, Password: *input.Password}
	return validateNetworkProxySecret(s.value)
}

type networkProxyClearInput bool

func (b *networkProxyClearInput) UnmarshalJSON(raw []byte) error {
	var value *bool
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return invalid("clearCredentials must be a boolean.")
	}
	*b = networkProxyClearInput(*value)
	return nil
}

func (a *App) updateNetworkProxy(r *Request) (*Response, error) {
	if err := r.requireOwner(); err != nil {
		return nil, err
	}
	var input struct {
		ExpectedRevision string                  `json:"expectedRevision"`
		Mode             string                  `json:"mode"`
		URL              *string                 `json:"url"`
		Secret           networkProxySecretInput `json:"secret"`
		ClearCredentials networkProxyClearInput  `json:"clearCredentials"`
	}
	if err := r.decode(&input); err != nil {
		return nil, err
	}
	expected, err := integrationRevision(input.ExpectedRevision)
	if err != nil || expected < 1 || input.URL == nil || !oneOf(input.Mode, "direct", "proxy") {
		return nil, invalid("Supply the expected revision, direct/proxy mode and proxy URL.")
	}
	if input.Secret.present && bool(input.ClearCredentials) {
		return nil, invalid("New proxy credentials and clearCredentials are mutually exclusive.")
	}
	endpoint, err := networkProxyURL(*input.URL)
	if err != nil {
		return nil, err
	}
	if input.Mode == "proxy" && endpoint == nil {
		return nil, invalid("Specify a proxy URL before enabling proxy mode.")
	}
	if endpoint == nil && input.Secret.present {
		return nil, invalid("Proxy credentials require a proxy URL.")
	}
	current, err := a.loadNetworkProxy(r.HTTP.Context(), r.Q)
	if err != nil {
		return nil, err
	}
	if expected != current.revision {
		return nil, &APIError{Status: 409, Code: "network_proxy_version_conflict", Message: "The saved proxy configuration has changed. Read it again before saving.", CurrentRevision: current.config.Revision}
	}
	if current.revision == math.MaxInt64 {
		return nil, conflict("Proxy configuration revision limit reached.")
	}
	canonical := ""
	if endpoint != nil {
		canonical = endpoint.String()
	}
	if canonical != current.config.URL && current.config.CredentialConfigured && !input.Secret.present && !bool(input.ClearCredentials) {
		return nil, invalid("Changing the proxy endpoint requires new credentials or an explicit clearCredentials selection.")
	}
	next := &networkProxyRuntime{revision: current.revision + 1, endpoint: endpoint, secret: current.secret, cipher: current.cipher}
	if bool(input.ClearCredentials) || endpoint == nil {
		next.secret, next.cipher = networkProxySecret{}, ""
	}
	if input.Secret.present {
		next.secret = input.Secret.value
		next.cipher, err = a.encryptNetworkProxySecret(next.secret)
		if err != nil {
			return nil, err
		}
	}
	next.config = NetworkProxyConfig{Revision: strconv.FormatInt(next.revision, 10), Mode: input.Mode, URL: canonical, CredentialConfigured: next.cipher != ""}
	var ciphertext any
	if next.cipher != "" {
		ciphertext = next.cipher
	}
	result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE network_proxy_config SET revision=?,mode=?,url=?,credential_cipher=? WHERE id=1 AND revision=?"), next.revision, input.Mode, canonical, ciphertext, expected)
	if err != nil {
		return nil, err
	}
	if n, err := result.RowsAffected(); err != nil || n != 1 {
		if err != nil {
			return nil, err
		}
		return nil, conflict("Proxy configuration changed while saving.")
	}
	r.NetworkProxyUpdate = next
	return ok(next.config), nil
}

// Applying a committed version cancels only operations that captured its
// predecessor. No operation silently changes from proxy to direct midway.
func (a *App) afterNetworkProxyCommit(r *Request) {
	if r.NetworkProxyUpdate == nil || a.networkProxy == nil {
		return
	}
	ctx, cancel := context.WithCancelCause(a.ctx)
	a.networkProxy.mu.Lock()
	old := a.networkProxy.current
	a.networkProxy.current = networkProxyGeneration{runtime: r.NetworkProxyUpdate, ctx: ctx, cancel: cancel}
	a.networkProxy.mu.Unlock()
	old.cancel(errNetworkProxyChanged)
	a.wakeAutoIconWorker()
	a.wakeIntegrationWorker()
}

func (a *App) beginNetworkOperation(parent context.Context) (context.Context, context.CancelFunc) {
	if a.networkProxy == nil {
		return parent, func() {}
	}
	a.networkProxy.mu.RLock()
	generation := a.networkProxy.current
	a.networkProxy.mu.RUnlock()
	ctx, cancel := context.WithCancelCause(parent)
	stop := context.AfterFunc(generation.ctx, func() { cancel(context.Cause(generation.ctx)) })
	if generation.ctx.Err() != nil {
		cancel(context.Cause(generation.ctx))
	}
	ctx = context.WithValue(ctx, networkProxyOperationKey{}, networkProxyOperation{runtime: generation.runtime, generation: generation.ctx})
	return ctx, func() { stop(); cancel(context.Canceled) }
}

func (a *App) checkNetworkOperation(ctx context.Context, q Queryer) error {
	operation, ok := ctx.Value(networkProxyOperationKey{}).(networkProxyOperation)
	if !ok {
		return nil
	}
	if errors.Is(context.Cause(ctx), errNetworkProxyChanged) || errors.Is(context.Cause(operation.generation), errNetworkProxyChanged) {
		return networkProxyChanged()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	var revision int64
	if err := q.QueryRowContext(ctx, "SELECT revision FROM network_proxy_config WHERE id=1").Scan(&revision); err != nil {
		return err
	}
	if revision != operation.runtime.revision {
		return networkProxyChanged()
	}
	return nil
}
