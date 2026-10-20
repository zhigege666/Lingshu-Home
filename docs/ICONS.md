# Icon libraries and cached website icons

This document describes the icon data and HTTP contract in `0.1.0-dev.1`. Homepage display choices, including minimal links and app-style icon cards, belong to the page/theme settings. Changing a display style preserves the link's saved icon reference.

## Sources and references

| Source | Saved `icon` value | Rendering and ownership |
| --- | --- | --- |
| Built-in outline collection | `lucide:house`, `lucide:link`, etc. | 30 local Lucide SVGs with fixed upstream commit, original licenses and checksums in [the manifest](../assets/icons/manifest.json) |
| Imported pack | `asset:<spaceId>:<sha256>` | Canonical image bytes stored in that space's database records; pack metadata retains the supplied source/license and original/canonical checksums |
| Website lookup | `asset:<spaceId>:<sha256>` | Home stores a validated image in the space, either after an authorized automatic-mode bookmark save/import or an explicit picker lookup |

Link and category writes accept only known bundled IDs or existing asset references from the same space. External navigation snapshots and existing MCP bookmark/category tools use the same image-reference validation. An arbitrary image URL, data URL, cross-space asset, missing hash or inline SVG cannot be saved into `icon`. Local bookmarks additionally record `iconMode:"auto"|"manual"`; the automatic mode uses `lucide:link` until an eligible image is available. Categories retain their `lucide:folder` fallback and have no automatic website lookup.

The same-origin image URL is `/api/v1/spaces/<spaceId>/icons/<sha256>`. Use it as an ordinary decorative `<img>`; do not inject SVG content into HTML. A theme may apply its monochrome treatment to the bundled Lucide collection. Imported/fetched color images should preserve their original colors.

## Access and persistence

All icon operations follow the existing four-mode space policy. A public viewer can read icons from a published shared space. Maintenance requires that space's edit permission; `open_edit` intentionally permits anonymous maintenance. Members can maintain their own personal icons and cannot modify shared icons. Owners cannot access another member's personal icon collection.

Browser mutations require a valid session-bound CSRF token. HTTP bearer tokens use existing `navigation:read` / `navigation:write` actions and their assigned space; icon endpoints do not broaden a token's actions or scope. The server reevaluates current identity, CSRF and space access after a website request and before saving its result.

Asset GETs reevaluate authorization and actual image existence before evaluating `If-None-Match`. Successful responses use `Cache-Control: private, no-cache`, a content-hash `ETag`, `Vary: Cookie, Authorization`, `X-Content-Type-Options: nosniff`, a restrictive SVG/document CSP and a same-origin resource policy. An authorized matching validator returns an empty `304`, allowing the browser to reuse image bytes after revalidation. Unauthorized/missing responses remain `no-store`. GETs never start an outbound lookup. Making an instance private or signing out takes effect at the next authorization check; there is no long-lived public or immutable image cache.

SQLite and PostgreSQL use `003_icons.sql` for image assets, pack metadata and per-space website results. The additive `005_auto_icons.sql` migration adds the default-on instance setting, each local bookmark's automatic/manual intent and canonical icon origin, and a bounded persistent job queue. Existing bookmark icons are preserved and marked `manual`; migration and starter-pack loading do not request their websites. No additional upload directory, image-service container, Redis instance or image-decoding dependency is required.

Back up the complete database and existing instance-key directory using [the storage guide](STORAGE.md). Navigation JSON retains link/category icon references, while bookmark HTML carries browser bookmark data; neither export includes the image bytes and complete library metadata. A database restore retains custom images and website caches. To return to code that predates this migration, restore its matching pre-upgrade database backup; the migration ledger deliberately rejects unknown migrations.

The Web link/category picker exposes a searchable built-in collection, space libraries and an import tab. It accepts the JSON contract below or one PNG/JPEG/static SVG image, which it wraps as a one-entry pack with a required license/ownership notice. A link also offers explicit website icon lookup. Imports, confirmed deletions and website-cache writes persist immediately; the selected reference is applied only when the link/category form is saved. Canceling that form does not roll back the library/cache operation. See the [English instructions](USER_GUIDE.md#choose-or-import-icons) or [中文操作](USER_GUIDE.zh-CN.md#选择或导入图标).

## Automatic website icons

**Access and accounts → Automatically fetch website icons** controls the whole instance and defaults to on. `GET /bootstrap` and `GET /settings` expose `autoFetchIcons`; `PUT /settings` accepts that optional boolean. Omitting it preserves the stored value. Once an Owner exists, only that Owner may change the switch; an ownerless `open_edit` instance can maintain it without an account. Changing only this switch does not revoke sessions or advance the authentication epoch.

| Operation | Result |
| --- | --- |
| Save a new Web bookmark with the default **Automatic** mode | Commit the bookmark first, then let the background worker acquire its public-origin icon |
| Import browser bookmarks | Imported links use automatic mode; preview alone performs no website lookup |
| Pick a built-in/library image, use the default icon, or explicitly fetch and select an image | The link uses manual mode and is protected from automatic replacement |
| Change an automatic link's website origin | Stop using the former website's fetched image; any late result for the former origin cannot overwrite the new link |
| Turn off `autoFetchIcons` | Clear pending automatic work, cancel/discard in-flight automatic results and keep saved images; manual picker lookup still works |
| Turn the switch on again | Future automatic-mode saves/imports can enqueue work; existing links are not batch-scanned or overwritten |
| Visit a homepage, reload images or wait for cache expiry | Read local data only; no external favicon request or per-bookmark refresh timer |

For API/MCP creation, an omitted `iconMode` with an explicitly supplied icon retains manual behavior; omission of both uses automatic mode. Existing callers can therefore keep selecting their icons. New callers should send the mode explicitly. An update that omits the mode preserves the existing intent unless it explicitly replaces the selected icon. Existing records upgraded from earlier versions remain manual; edit an individual bookmark and choose Automatic to opt it in.

The persistent queue deduplicates by space and canonical origin and runs one remote lookup at a time, sharing the existing fetch gate with explicit lookups and component-template retrieval. A space can have at most 512 distinct cached or pending origins; the instance can have at most 2,048 pending origins. Capacity exhaustion does not roll back an otherwise valid bookmark/import. The link retains its fallback or existing image.

Origin and image-capacity checks occur before starting a new network request. A remote cache miss or refresh requires fewer than 1,024 retained custom image hashes and at least 256 KiB remaining in the space's 32 MiB canonical-image budget. Checking room for one maximum-size image avoids starting with insufficient capacity; final insertion checks the actual image bytes again. With less room, Home skips automatic fetching and an explicit lookup reports the capacity error. Existing cached images remain readable.

Jobs become visible only after the authorized bookmark transaction commits. A worker wakes on committed work and once at startup to recover interrupted jobs; an empty queue has no periodic timer. Network I/O holds neither a SQL transaction nor the navigation write gate. The worker checks the current setting, job identity, saved automatic intent and current authorization before requesting and before applying a result. Switching to manual, deleting/changing the link, changing permissions or disabling automation prevents obsolete results from overwriting that link. No raw session or PAT secret is stored in a job.

A successful result updates only automatic links that still belong to the job's space and origin, and advances the local navigation revision. Manual links, categories, page configuration and external source snapshots remain independent. Failures retain the previous good image or fallback and use the existing negative cache; there is no autonomous retry loop. A later eligible save or explicit lookup can retry after expiry. Newly fetched images appear on the next navigation read; the interface provides **Refresh list** and **Refresh content** without adding a background navigation polling loop.

The selected database is the authoritative store. SQLite stores canonical bytes as BLOBs; PostgreSQL stores them as BYTEA. Content hashes deduplicate repeated image bytes within a space, and multiple devices read the same saved reference. Browser HTTP caching is an optimization; Home does not keep its only copy in `localStorage` or IndexedDB, and clearing browser data does not delete the server's images.

## Import a pack

`POST /api/v1/spaces/{spaceId}/icon-packs` accepts a JSON object. The request is atomic: one invalid image, duplicate key or exceeded limit rejects the whole pack and its new image bytes.

```json
{
  "schemaVersion": 1,
  "name": "Personal outline",
  "sourceUrl": "",
  "license": "Original example artwork, Apache-2.0",
  "icons": [
    {
      "key": "home",
      "label": "Home",
      "mediaType": "image/svg+xml",
      "dataBase64": "PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik00IDEyIDEyIDQgMjAgMTJNNiAxMHYxMGgxMlYxMCIvPjwvc3ZnPg=="
    }
  ]
}
```

The example is original project artwork. When importing another collection, retain its actual source and license instead of copying this example notice. Home records this supplied metadata; it does not determine whether the uploader has the required rights.

| Field or limit | Accepted value |
| --- | --- |
| `schemaVersion` | Exactly `1` |
| `name` | 1–80 characters |
| `sourceUrl` | Empty, or an absolute HTTP/HTTPS provenance URL; this field is not fetched |
| `license` | 1–2,048 characters containing a concise license/ownership notice |
| `icons` | 1–64 entries per pack |
| `key` | Unique within the pack; 1–64 lowercase letters, numbers, `.`, `_`, `-`; first character is a letter or number |
| `label` | 1–80 characters |
| `mediaType` | `image/png`, `image/jpeg`, `image/svg+xml` |
| `dataBase64` | Standard base64 image bytes, without a `data:` prefix |
| Per-image size | At most 256 KiB before and after normalization; SVG input at most 64 KiB |
| Dimensions | 1–512 px in each dimension; SVG requires a bounded positive `viewBox` |
| Per-pack body | At most 4 MiB of decoded images |
| Per-space storage | At most 32 packs, 1,024 distinct custom image hashes and 32 MiB of canonical image bytes |

PNG/JPEG input is decoded and rewritten as PNG, discarding unrelated metadata. Declared MIME and decoded format must agree. Dimensions are checked before full decoding.

SVG support intentionally covers static outline and solid-color geometry: `svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polygon` and `polyline`, with bounded numeric geometry, transforms, fills and strokes. Colors support `currentColor`, `none`, black/white/transparent and hex values. Comments are removed. Scripts, event handlers, stylesheets, arbitrary namespaces, external references, embedded images, gradients, `use`, filters, text, animation, XML declarations and directives are rejected. Convert more complex artwork to PNG before import. ZIP archives and executable icon-font/CSS packages are not accepted by this endpoint.

The `201` response contains:

```text
{
  id, spaceId, name, sourceUrl, license, createdAt,
  icons: [{ key, label, ref, url, mediaType, width, height, sha256, sourceSha256 }]
}
```

`sourceSha256` identifies the uploaded image; `sha256` identifies the canonical bytes Home actually serves. Identical canonical content is deduplicated within a space. Importing a pack does not change any link or category until its returned `ref` is explicitly selected and saved.

### List and remove packs

- `GET /api/v1/spaces/{spaceId}/icon-packs` returns `{ "packs": [...] }` using the response shape above, without base64 image bodies. The bundled collection remains in the static manifest and is not duplicated in this list.
- `DELETE /api/v1/spaces/{spaceId}/icon-packs/{id}` returns `204`. If deleting the last library owner would remove an icon still referenced by a link, category, page or external source snapshot, the endpoint returns `409`. Replace those saved references first.
- If another pack or website-cache record retains the identical image hash, deleting one pack preserves the shared image. Unreferenced images belonging exclusively to the removed pack are deleted in the same transaction. A wrong-space or missing pack returns `404`.

## Fetch a website icon explicitly

`POST /api/v1/spaces/{spaceId}/icons/fetch` accepts:

```json
{ "url": "https://example.org/a/bookmark/path?private=not-forwarded" }
```

Only the scheme and host are used for the initial lookup: Home requests `https://example.org/`. The bookmark's private path, query and fragment are not forwarded. The response supplies a picker/draft value; this operation does not save or overwrite a bookmark:

```text
{
  ref, url, sha256, mediaType, width, height,
  cached: false,
  stale: false,
  sourceUrl: "https://example.org/icon.png"
}
```

The server looks for up to three declared `rel="icon"` or `rel="apple-touch-icon"` candidates in the document head, then attempts `/favicon.ico`. PNG, JPEG and the supported static SVG subset are accepted. ICO input is decoded to PNG when it contains a valid bounded PNG image or an uncompressed 24-/32-bit DIB image. Paletted, compressed or otherwise unsupported ICO variants require importing a PNG alternative. Browser JavaScript is not run; a site whose icon is available only after login or script execution may need manual import.

Successful results are cached per space and canonical website origin for 24 hours. An initial failure returns `422 favicon_unavailable` and is negatively cached for 30 minutes. A failed refresh preserves a previous successful image and returns `cached: true, stale: true`; the next refresh is eligible after 30 minutes. Refreshing is driven by another eligible authorized save/import or explicit request after expiry. Expiry itself does not schedule a lookup. There is no visitor-triggered network request or background per-bookmark polling.

### Outbound request policy

The implementation only fetches public Internet destinations on standard HTTP port 80 or HTTPS port 443. It rejects private, loopback, link-local, shared/CGNAT, reserved, documentation and IPv6 transition address ranges, plus local/reserved hostname suffixes. A hostname with any non-public resolved address is rejected. Internal services remain valid navigation links; import their icons locally.

DNS resolution occurs at connection time, and the connection is pinned to a validated literal address while HTTP Host and TLS SNI/certificate verification retain the original hostname. Every redirect target and fallback connection goes through the same destination policy. The client has no ambient proxy, cookie jar, credentials or forwarded Authorization/Referer. It does not call Google, DuckDuckGo or another favicon proxy.

Each lookup has a 10-second overall deadline, at most six HTTP requests, three redirects per request chain, a 256 KiB image limit and a 1 MiB total response budget. The initial document has a 3-second subdeadline. Only HTML/XHTML may be read as a prefix: Home reads at most 512 KiB, stops at `</head>` or `<body>`, and can use complete icon tags without waiting for a large or slow page body. Actual prefix bytes count toward the total budget. Images still require a complete bounded response; this does not allow truncated images or SVG. Declared-icon attempts leave two seconds, one request and up to 256 KiB available to the conventional `/favicon.ico` fallback, within the same overall limits. Compressed responses are rejected. One remote lookup may run at a time per instance; an additional active lookup returns `429 icon_fetch_busy`. SQL transactions and the navigation write gate are released while network work runs. A space may cache at most 512 origins.

These controls follow the [OWASP SSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) on destination validation and pinned connections. Image handling uses the [Go image decoding APIs](https://pkg.go.dev/image) with dimension checks, and serves static SVG through ordinary image URLs as described by [MDN's SVG-as-image guidance](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image).

## Verification

From `server/`, run `go test ./internal/home -run '^(TestIcon|TestAutomaticIcon)' -count=1`. The icon suite includes image normalization, malicious SVG rejection, existing bundled SVGs, ICO conversion, destination/DNS pinning, redirect/body/deadline boundaries, large HTML head-prefix discovery, early close before a slow body, slow-head fallback, strict binary and aggregate byte limits, transactional pack rollback, SQLite restart, mode/space/CSRF/PAT checks, actual MCP custom-icon writes, external snapshot references, positive/negative/stale caches and authorization changes during network work. It also covers private conditional GETs, automatic/manual intent, queue admission and rollback, in-flight origin deduplication, obsolete-result rejection, disable/restart behavior and migration 005 preservation and failure rollback.

PostgreSQL tests use a dedicated disposable database selected by `LINGSHU_TEST_ICONS_POSTGRES_URL`, separate from the other provider suites and any running instance. The original icon-storage cases require an uninitialized application schema and refuse to erase existing data. Automatic-icon lifecycle and migration cases reuse this dedicated database through their own randomly named schemas; the test account needs permission to create schemas, and each case cleans up only its own schema. PostgreSQL cases explicitly skip when the variable is absent. Test network responses are controlled fixtures; passing them does not claim that every Internet site or ICO encoding is supported. Runtime and actual deployment results belong in [the verification record](../tests/README.md).

## 中文使用要点

- 预制图标是本地的简约 Lucide 线性图标。简约链接、图文卡片和应用图标样式由主题/组件控制，切换样式不会改写链接保存的图标。
- 选择器可以导入上面的 JSON 图标库，也可导入单张 PNG、JPEG 或受限静态 SVG。每库最多 64 张，填写真实来源和许可说明；复杂 SVG 可先转成 PNG。接口不接收 ZIP、图标字体、CSS 包或可执行内容。
- 导入、确认删除及网站缓存立即写入当前空间，所选引用随链接/分类表单保存；取消表单只放弃选择，不撤销已完成的图标库或缓存操作。
- 导入和网站图标获取遵守当前空间的维护权限。选择完全开放模式后，免登录维护仍然可用，同时保留 CSRF 校验；个人空间图标不会跨用户公开。
- “访问与账号 → 自动获取网页图标”默认开启。新增/导入书签默认使用自动模式，保存提交后由单个后台任务逐项获取；选择内置/导入图标会转为手动模式。旧链接升级时保留原图标，可逐条改为自动。
- 关闭开关会清理待办并取消/丢弃在途自动结果，保留已保存图片；“获取网站图标”仍可主动使用。重新开启不会批量扫描旧链接，后续保存/导入才会排队。
- 服务端只访问网站公开根地址和图标候选地址，缓存后由 Home 自己提供图片；普通访客浏览首页不会触发远程获取。内网网站图标使用本地导入。浏览器仅用带权限重新验证的 HTTP 缓存，图片权威副本保存在数据库。
- HTML/XHTML 只读取有界的 head/前缀，到页头结束或 body 开始就停止，最多 512 KiB、初始阶段最多 3 秒；大页面无需等待完整下载。图片仍完整校验，总流程不超过 10 秒/6 次请求/1 MiB，并为 `/favicon.ico` 保留请求、时间和图片预算。
- 主动获取的结果先用于选择器/草稿，保存链接后才会替换原图标；自动任务会直接更新仍符合自动模式、空间和网站来源条件的已保存链接。成功缓存 24 小时，失败缓存 30 分钟；刷新失败时保留上一次成功的图标。
- 每个空间最多保留 1,024 个自定义图片哈希、32 MiB 标准化图片内容和 512 个不同的已缓存/待办网站来源，实例最多有 2,048 个待办来源。远程获取或刷新前，图片数量必须少于 1,024，且至少剩余 256 KiB 图片预算；余量不足时不开始请求，已缓存图片仍可读取。
- 删除图标库不会悄悄改写链接。仍被链接、分类、页面或外部快照引用且没有其他图标库/缓存保留的图片，会阻止删除并返回 `409`。
- 自定义图片、图标库信息、站点缓存、自动开关和待办保存在所选数据库中；本次增加 SQLite/PostgreSQL 的 `005_auto_icons.sql`，保留旧链接图标。完整备份需要数据库及原有实例密钥；书签 JSON/HTML 导出不包含图片二进制。
