# Network settings and bookmark routing

Home has two separate network controls. Both are available in **Admin → Network**.

| Control | Default | Runs where | Applies to |
| --- | --- | --- | --- |
| Automatically select internal or external routes | On | The visitor's browser | Explicit network alternatives on the clicked local bookmark |
| Server outbound proxy | Direct | The Home server | Website icons, component templates, ICS subscriptions, weather, HTTP JSON and GitHub Traffic |

Saving either control does not change access mode, registration, automatic-icon intent, or the authentication epoch. A server proxy does not configure the visitor's browser/system proxy or tunnel bookmark navigation.

## Destination policies

The current development source removes the public-only/standard-port restriction from website icons and component templates. This changes no database schema or access permission.

| Feature | Private-network access | Ports and remaining requirements |
| --- | --- | --- |
| Manual and automatic website icons | RFC1918/ULA or a resolvable LAN name on the hostname initially supplied by the editor | HTTP/HTTPS 1–65535; request only the bookmark origin, never its private path/query/fragment; port remains part of the cache key |
| Component template discovery and preview | The same initial-host scope as icons, retained across discovery, redirects and nested preview | HTTP/HTTPS 1–65535; bounded declarative JSON/HTML only; no browser credentials or remote code |
| HTTP JSON and ICS sources | Existing explicit per-source `allowPrivateNetwork` option | Custom HTTP/HTTPS ports already supported; source credentials retain their original origin rules |
| Browser internal/external route selection | Browser must be able to reach the explicitly configured route | Custom HTTP/HTTPS ports; browser CORS/private-network/certificate policies still apply |
| Weather and GitHub Traffic | Fixed public providers | These adapters do not accept arbitrary private upstream providers |

For icons/templates, every DNS result is validated before opening a connection; the dial receives a validated IP literal. Only the initially chosen hostname may use eligible private IPs. Redirects and HTML candidates on other hosts must remain public. Changing the port/scheme on the original host does not reset or broaden that scope. Loopback, link-local, metadata, CGNAT, reserved and IPv6 transition destinations are still rejected. HTTPS certificate verification remains enabled. LAN names and IPs are interpreted from the Home server/container, including when a proxy is configured.

## Configure bookmark alternatives

Keep a primary URL as the final fallback. In the link editor, add explicitly marked **Internal** and **External** network routes. Ordinary additional links, including documentation and admin pages, remain direct manual links and do not participate in automatic selection. Existing additional links are never classified from their labels or IP addresses.

```json
{
  "title": "NAS",
  "url": "https://nas.example.org/files",
  "endpoints": [
    {"label":"LAN","url":"http://192.168.1.20:5000/files","route":"internal","probePath":"/healthz"},
    {"label":"Internet","url":"https://nas.example.org/files","route":"external"},
    {"label":"Documentation","url":"https://docs.example.org/nas"}
  ]
}
```

`route` and `probePath` are optional additions to the existing endpoint JSON; no additional link column or migration of existing endpoint records is needed. There are at most 12 total endpoint records, including ordinary additional links. REST and MCP local-navigation writes share validation. Remote navigation snapshots still accept only `label` and `url` and cannot authorize a browser to probe a local network.

For a marked route, an omitted/empty `probePath` means `/favicon.ico`. A custom path must start with one `/`, contain at most 256 ASCII characters from letters, digits, `/`, `_`, `-`, `.`, `~`, and contain no independent `.` or `..` segments. Queries, fragments, encoded characters, whitespace, backslashes and absolute URLs are rejected. Configure a read-only path that responds without login. The probe never reuses the bookmark's full path, query or fragment.

## Browser selection and its limits

Only an intentional primary-link click starts selection. Loading, rendering, hovering, focusing and leaving Home idle do not probe links or schedule periodic scans. A shared page router allows at most two concurrent probes, up to 32 pending selections and an 800 ms selection budget. It uses the first responsive internal candidate available within the budget; otherwise it uses a responsive external candidate, the first configured external URL, or the primary URL. This is a bounded preference for an internal response, not a complete throughput benchmark of every destination.

Probes use `GET`, `mode:cors`, `credentials:omit`, `redirect:error`, no referrer and no HTTP cache. They request only the origin plus the explicit/default probe path and do not follow a redirect. A cross-origin probe must return `Access-Control-Allow-Origin` for the Home origin, or `*` on a deliberately public, credential-free health path. Without that response header, the browser cannot confirm the response and Home falls back to the external/primary route. Configure a read-only `/healthz` on the service or its reverse proxy when the default favicon cannot be read across origins. Do not broadly expose authenticated application responses merely to support this check.

A readable HTTP response establishes that this probe path responded; it does not prove application health, successful authentication or usability of the full bookmarked page. Opaque responses, redirects, network errors, policy denials and timeouts remain unknown. There is no credentialed retry or certificate bypass. The [Fetch standard](https://fetch.spec.whatwg.org/#main-fetch) requires `no-cors` requests to follow redirects; pairing `no-cors` with `redirect:error` fails before networking. Home uses CORS to retain the explicit no-redirect boundary.

Observations stay only in browser memory: positive observations live at most 30 seconds, unknown observations 5 seconds, and the cache contains at most 128 entries. Keys include the route origin/path and the current application context. Clearing, changing context, going offline/online, and disposing the router invalidate old work; there is no localStorage/IndexedDB database of private network addresses. Disabling automatic selection opens the primary URL directly. Explicit route chips always open the chosen URL; modifier keys and middle-click retain native browser navigation.

Browsers enforce their own local-network access, mixed-content, TLS and permission policies. Home does not bypass them. A browser may require a user grant or refuse an HTTPS-to-HTTP/private-network check; another browser may support different behavior. The Internal route supplies an address-space hint where supported. Manual routes and external fallback remain available when detection is blocked. See the browser vendors' [Local Network Access guidance](https://developer.chrome.com/blog/local-network-access) and [request-mode documentation](https://developer.mozilla.org/en-US/docs/Web/API/Request/mode).

## Automatic-selection API

`GET /api/v1/bootstrap` and permitted `GET /api/v1/settings` include `autoSelectEndpoint:boolean`, default `true` for new and upgraded databases.

```http
PUT /api/v1/settings/navigation
Content-Type: application/json
X-CSRF-Token: <current browser token>

{"autoSelectEndpoint":true}
```

The response is `{"autoSelectEndpoint":true}`. This narrow endpoint rejects omitted, null, nonboolean and unknown fields. Once an Owner exists, only that Owner can write it. An ownerless `open_edit` instance may write it with normal browser CSRF protection. PAT administration is rejected. Existing `PUT /settings` also accepts an optional `autoSelectEndpoint`; omission retains its current value.

## Server outbound proxy

The default is direct connections. An Owner can select an explicit `http://host:port`, `https://host:port` or `socks5://host:port` proxy. Environment proxy variables are not inherited. Proxy addresses are interpreted from the Home server (or its container); `127.0.0.1` does not refer to the visitor's computer. Proxy endpoints can be explicitly selected on loopback/private networks or the public Internet, while metadata, link-local and reserved destinations remain blocked. A proxy failure does not silently retry directly.

Home resolves the target hostname locally, validates its addresses against the fetcher's existing policy, and pins the target IP before tunnelling. Icons and templates use the initial-host private-network scope above; weather and GitHub retain fixed public providers. Explicitly authorized private HTTP/ICS sources keep their existing per-source policy. HTTP and HTTPS proxies receive `CONNECT <validated-IP>:<port>`; SOCKS5 receives an IPv4/IPv6 literal, not a hostname for remote DNS resolution. HTTPS target certificates are checked against the original target hostname, and an HTTPS proxy's own certificate is checked separately using system trust.

HTTP proxies must permit CONNECT for the target port, including port 80 when fetching an HTTP source. A proxy that only supports ordinary HTTP absolute-form forwarding will reject that traffic. DNS resolution remains on the Home server. This prevents proxy-side target resolution from bypassing Home's address policy, and should be considered when diagnosing name-resolution failures.

Both `GET` and `PUT /api/v1/network-proxy` require an Owner browser session; they reject anonymous users, Members and PATs. Ownerless instances must create an Owner before managing a server proxy. The proxy URL and stored credential status are not part of public bootstrap or navigation export.

```json
{
  "revision": "1",
  "mode": "direct",
  "url": "",
  "credentialConfigured": false
}
```

To update, send the current revision and desired mode/URL. Supply credentials separately from the URL:

```json
{
  "expectedRevision": "1",
  "mode": "proxy",
  "url": "http://127.0.0.1:7890",
  "secret": {"username":"example-user","password":"example-password"}
}
```

The response is the public projection above with an incremented revision; neither username nor password is ever returned. Omitting `secret` preserves credentials for the same endpoint. `clearCredentials:true` removes them; it is mutually exclusive with new credentials. Changing an endpoint that has saved credentials requires replacements or an explicit clear. Direct mode may retain a configured endpoint and encrypted credentials for re-enabling. Removing the endpoint also requires clearing saved credentials.

Unknown fields, embedded credentials, non-root URL paths, queries/fragments and invalid protocols/ports are rejected. Proxy URLs are limited to 2048 bytes with an explicit port from 1 to 65535; the API canonicalizes an optional trailing `/` away. Both credential values must have 1–255 UTF-8 bytes without control characters; usernames cannot contain a colon. Concurrent saves return HTTP 409 `network_proxy_version_conflict` with `currentRevision`. The UI keeps the draft and offers an explicit reload before editing again.

Saving validates syntax and persists the configuration without testing connectivity or advancing source polling schedules. An interrupted polling source retries on its existing schedule or an explicit Sync; automatic-icon jobs remain queued and retry with the new configuration, while existing cached content is retained. Saving a new revision cancels networking from its predecessor, including connection establishment. Late results cannot update icon caches or source snapshots under the old revision. In-flight explicit operations may return `network_proxy_changed` and can be retried. No polling daemon, proxy health loop or arbitrary-target test endpoint is added.

## Persistence and recovery

Migration `006_network_routing.sql` is additive for SQLite and PostgreSQL. It adds the default-on `settings.auto_select_endpoint` and singleton `network_proxy_config` with revision, mode, credential-free URL and nullable ciphertext. Existing navigation, settings, credentials, caches and job rows are preserved; migrations 001–005 stay unchanged.

Proxy credentials use AES-256-GCM with a fresh nonce and proxy-specific associated data, under the existing private `integrations.key`. Source credentials use a different associated-data context. Back up both the database and its matching keys. Startup refuses to generate a replacement key when either source or proxy ciphertext already exists. Restoring an older binary requires its matching database/key backup, because it cannot open a database with a newer migration.

The browser cache is disposable and is never the authoritative store for proxy settings, link routes or icons. No additional service, database engine, key file or periodic task is required.
