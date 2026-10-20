ARG NODE_IMAGE=node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ARG GO_IMAGE=golang:1.26.8-bookworm@sha256:dc9ad6c05acc7a88e5b71bde60a5fe3bd4b9f0db209011711b464107438a8107
ARG RUNTIME_IMAGE=debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
FROM ${NODE_IMAGE} AS web
WORKDIR /build
COPY VERSION ./VERSION
COPY assets/icons/ ./assets/icons/
COPY web/package.json web/package-lock.json ./web/
RUN npm ci --prefix web --no-fund
COPY web/ ./web/
COPY scripts/collect_node_licenses.mjs ./scripts/collect_node_licenses.mjs
RUN npm run build --prefix web
RUN node scripts/collect_node_licenses.mjs /build/licenses/npm

FROM ${GO_IMAGE} AS server
WORKDIR /build/server
ARG GOPROXY=https://proxy.golang.org,direct
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY scripts/collect_go_licenses.go /build/scripts/collect_go_licenses.go
COPY assets/licenses/go/ /build/assets/licenses/go/
RUN CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags="-s -w" -o /build/lingshu-home ./cmd/lingshu-home
RUN CGO_ENABLED=0 go run ../scripts/collect_go_licenses.go /build/licenses/go

FROM ${RUNTIME_IMAGE} AS runtime
COPY --from=server /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN groupadd --gid 10001 lingshu \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /app --shell /usr/sbin/nologin lingshu \
    && mkdir /data && chown 10001:10001 /data
WORKDIR /app
ENV LINGSHU_LISTEN=0.0.0.0:8080 \
    LINGSHU_DATA_DIR=/data \
    LINGSHU_STORAGE_PROVIDER=sqlite \
    LINGSHU_WEB_DIR=/app/wwwroot \
    LINGSHU_VERSION_FILE=/app/VERSION
COPY --from=server /build/lingshu-home ./lingshu-home
COPY --from=web /build/web/dist/ ./wwwroot/
COPY --from=web /build/licenses/npm/ ./licenses/npm/
COPY --from=server /build/licenses/go/ ./licenses/go/
COPY VERSION LICENSE THIRD_PARTY_NOTICES.md ./
COPY web/vendor/reui/ ./licenses/reui/
COPY assets/icons/licenses/ ./licenses/icons/
USER 10001:10001
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["/app/lingshu-home"]
