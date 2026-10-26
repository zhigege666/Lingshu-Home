# Transport encryption

Home can serve its UI, HTTP API, MCP endpoint and protected document responses through HTTPS. Choose direct TLS or a trusted reverse proxy. They provide transport encryption; they do not encrypt Markdown files on disk or make document access end-to-end encrypted. Home and any TLS-terminating proxy can read the content they process.

## Direct HTTPS

Since 0.0.5, Home supports a PEM certificate chain and matching PEM private key:

| Environment variable | Command-line flag | Meaning |
| --- | --- | --- |
| `LINGSHU_TLS_CERT_FILE` | `--tls-cert-file` | PEM certificate chain, with the server certificate first |
| `LINGSHU_TLS_KEY_FILE` | `--tls-key-file` | Matching PEM private key |
| `LINGSHU_LISTEN` | `--listen` | Address used by the selected HTTP or HTTPS listener |

From the updated checkout's repository root, build the source and run the resulting binary from that same directory. The build requires the toolchains listed in the README and writes the executable to `dist/lingshu-home`:

```bash
python3 scripts/dev.py build
./dist/lingshu-home \
  --listen 0.0.0.0:5443 \
  --data-dir /var/lib/lingshu-home \
  --tls-cert-file /etc/lingshu-home/tls/fullchain.pem \
  --tls-key-file /etc/lingshu-home/tls/privkey.pem
```

Use `https://` with the host name covered by the certificate and the configured port. Certificates must be trusted by every browser and Agent client. For an internal CA, install its public root certificate in those clients' trust stores; do not disable verification. Keep the private key restricted to the service identity.

Both TLS paths must be set together. An incomplete configuration, an unreadable file, an invalid PEM pair or a mismatched key stops startup. The pair is loaded before Home opens its business database; it never falls back to HTTP after a TLS error. Home uses TLS 1.2 as the minimum and allows TLS 1.3. One listener serves the UI, `/api/v1`, `/mcp` and authenticated document routes, so the same transport protection applies to each.

With neither TLS path configured, Home preserves its HTTP listener and default loopback address for local use or a reverse proxy. `LINGSHU_SECURE_COOKIES=true` alone changes cookie policy; it does not start HTTPS or encrypt an HTTP connection. Direct HTTPS automatically gives session and CSRF cookies the Secure attribute through the request's TLS state.

Home loads the certificate at startup. Renew it using your certificate manager, then restart Home to load the new pair. Home does not issue certificates, renew them, hot-reload them or redirect a separate HTTP port. Startup checks the PEM/key pair, while clients check validity dates, host identity and certificate trust during their connection.

### Development helper

`python3 scripts/dev.py start` inherits the two TLS variables, selects HTTPS for its health check and verifies both certificate trust and the requested host name. For a private CA, `SSL_CERT_FILE` can point to the CA certificate trusted by the helper's standard TLS client. This is a trust configuration, not a certificate-verification bypass.

The health check uses the configured listen host, substituting `127.0.0.1` for `0.0.0.0` and `::1` for `::`. The certificate must cover that host/IP. If a production certificate covers only a different DNS name, use an appropriate local listening name or run the binary/`dev.py run` in the foreground; do not suppress hostname verification. The health check connects directly rather than using environment HTTP proxies.

A failed background startup, including a certificate-validation failure, stops only the child process started by that invocation and removes its matching runtime state. It first allows graceful shutdown and uses a bounded forced cleanup only if that newly started process does not exit. Existing application data and unrelated processes are retained. The ordinary `dev.py stop` behavior is unchanged.

### Docker

The 0.0.6 image retains direct TLS, introduced in 0.0.5. Image installations can add the certificate mount and both TLS environment settings below to their existing container definition; the 0.0.4 image does not support them. The supplied Compose files build the matching 0.0.6 source. Upgrading retains the existing certificate mount, TLS variables and instance data; migrations 009/010 do not require a TLS configuration change. From that checkout's repository root, set the existing host certificate directory and apply the TLS override with a base deployment:

```bash
export LINGSHU_CERTS_DIR=/srv/lingshu-home/tls
docker compose -f compose.yaml -f compose.tls.yaml up -d --build
```

That directory must contain readable `fullchain.pem` and `privkey.pem` files. To enable the document mounts and HTTPS together, configure all three existing host directories and include both overrides:

```bash
export LINGSHU_NOTES_DIR=/mnt/user/knowledge/notes
export LINGSHU_PROJECT_DOCS_DIR=/mnt/user/projects/docs
export LINGSHU_CERTS_DIR=/srv/lingshu-home/tls
docker compose -f compose.yaml -f compose.documents.yaml -f compose.tls.yaml up -d --build
```

For PostgreSQL, replace `compose.yaml` with `compose.postgres.yaml` and supply `LINGSHU_DATABASE_URL` as described in the README. Both overrides require a base Compose file; they are not standalone deployments. Keep the same file combination and environment when applying later configuration changes.

The TLS override retains the base port mapping **`127.0.0.1:5180` on the Docker host → `8080` in the container**. Home now serves HTTPS on that listener; it does not also serve HTTP there. Access it from the Docker host at `https://<certificate-covered-hostname-or-IP>:5180`, with that name resolving to the host's loopback interface. For example, `https://localhost:5180` works only when the certificate covers `localhost` and the client trusts its issuer. The `5443` port in the standalone-binary example above does not apply to this Compose deployment. The override does not publish port `443`, change the loopback binding, open remote access or add an HTTP redirect. To expose a different interface or port, configure the deployment explicitly and retain certificate verification for the address clients use.

Mount the certificate directory read-only, separately from document roots and the writable `/data` directory. Configure the two TLS variables with their **container paths**. For example, a certificate mount could use:

```yaml
volumes:
  - type: bind
    source: /srv/lingshu-home/tls
    target: /certs
    read_only: true
    bind:
      create_host_path: false
environment:
  LINGSHU_TLS_CERT_FILE: /certs/fullchain.pem
  LINGSHU_TLS_KEY_FILE: /certs/privkey.pem
```

This is a service configuration fragment, not a replacement for the deployment's existing data volume, image, identity or published ports. The container's service user must be able to read the certificate and key. Keep certificate directories outside all document roots so they cannot become library content. Mounting a certificate directory is preferable to mounting an individual file when a certificate manager replaces files during renewal; restart Home after renewal in either case.

## HTTPS reverse proxy

An existing Caddy, Nginx or other trusted HTTPS reverse proxy may continue to terminate TLS. For Caddy on the same host as a Home process listening at `127.0.0.1:5180`, a minimal example is:

```caddyfile
home.example.com {
    reverse_proxy 127.0.0.1:5180
}
```

Set `LINGSHU_SECURE_COOKIES=true` in Home and publish only the proxy's HTTPS endpoint to users and Agent clients. The domain, DNS and certificate validation must be configured for the actual deployment. Caddy can manage publicly trusted certificates for eligible names; local/internal certificates require client trust configuration. If Caddy runs in another container, its loopback address is not Home's loopback address: use the Home service name on a restricted shared container network instead.

This example encrypts the client-to-proxy connection. Its proxy-to-Home hop is plain HTTP over the same host's loopback interface. If that hop crosses machines or an untrusted network, use Home's direct TLS listener as an HTTPS upstream with certificate and host-name verification, or use an appropriately protected tunnel. Never configure an insecure certificate-verification bypass to make an upstream connect.

Home does not treat a client-supplied `X-Forwarded-Proto` header as proof of TLS. Use the explicit Secure-cookie configuration behind a proxy and restrict direct access to Home's backend listener. The proxy should overwrite forwarded headers and trust additional upstream proxies only when their addresses are explicitly configured. Do not expose an alternative plain-HTTP port carrying sessions, passwords or bearer tokens.

For API and MCP clients, configure the HTTPS URL directly. An HTTP redirect cannot protect a token that a client already sent over HTTP before following the redirect. TLS supplements existing account, token-scope and space permissions; it does not replace them.

## Mounted folders and NAS connections

Docker bind mounts expose a path from the Docker daemon host to the container. They do not add network encryption. A local disk directory has no separate network hop between the host and that disk. If the host directory is backed by a NAS/network filesystem, encryption of that connection is configured on the host and storage server independently of Home's HTTPS listener.

| Storage path | Encryption responsibility |
| --- | --- |
| Local disk bind mount | Disk/file-system encryption, if required; no additional network transport |
| SMB-mounted NAS directory | SMB client/server encryption configuration; an SMB3 version number alone is not proof that encryption was negotiated |
| NFS-mounted directory | A supported encrypted NFS configuration, such as Kerberos privacy (`sec=krb5p`) or supported NFS-over-TLS, or a protected network tunnel |
| Database, history and backups | Their own storage and transport configuration, independently of browser HTTPS |

For Linux SMB mounts, `seal` requests encryption; signing alone provides a different property. For NFS, plain `sec=sys` is not encryption, and authentication-only `sec=krb5` is not the privacy mode. NFS-over-TLS availability depends on the client kernel, tools and storage server. Check the actual host/NAS implementation rather than assuming every Docker or Unraid system supports the same features.

Home cannot infer whether a remote storage connection is encrypted from a container directory path. Do not present a directory as verified encrypted merely because it is reachable or because the browser uses HTTPS. Existing Markdown remains normal files for compatible editors; encryption at rest, backups and host administrators' access remain separate concerns.

## Verification

The automated TLS tests cover configuration pairing and flag precedence; invalid certificates failing before database initialization; successful TLS 1.2/1.3 requests; rejected TLS 1.0/1.1; untrusted or wrong-host certificates; and plain HTTP failing to reach the TLS application's handler. Existing server shutdown tests also exercise the same lifecycle helper used for TLS.

The development-helper tests additionally use a temporary HTTPS server to check a trusted private CA, rejection of an untrusted CA and hostname mismatch, and bypass of environment proxies. A real owned-process regression verifies that a failed certificate check removes the new background child and its state without stopping an unrelated process.

For a deployment, additionally verify the real certificate chain and name, the reverse proxy's actual upstream protocol, the absence of publicly reachable plain-HTTP backend ports, Secure cookies after login, and any NAS encryption configuration. Tests with temporary certificates do not establish that a production domain or storage mount is encrypted.

## Primary references

- [Go HTTP TLS server](https://pkg.go.dev/net/http#Server.ListenAndServeTLS)
- [Go TLS configuration](https://pkg.go.dev/crypto/tls#Config)
- [Caddy automatic HTTPS and local certificate trust](https://caddyserver.com/docs/automatic-https)
- [Caddy proxy headers and HTTPS upstream verification](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)
- [Linux CIFS mount options](https://docs.kernel.org/admin-guide/cifs/usage.html)
- [Red Hat file systems: SMB/NFS security and supported TLS configurations](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/htmlsingle/managing_file_systems/index)
