<img src="https://raw.githubusercontent.com/zhigege666/Lingshu-Home/v0.0.2/web/src/assets/lingshu-home-logo.svg" alt="Lingshu-Home logo" width="80" height="80">

# Lingshu-Home

**English** | [简体中文](README.zh-CN.md)

**An independent personal dashboard with navigation at its core.**

Maintain your links, import browser bookmarks, and compose your homepage from data sources, panels, layouts, and themes. Home provides its own admin interface, accounts, database, HTTP API, and MCP endpoint. Other services connect through optional integrations.

The jade folded-house logo is shared throughout the Web interface. [Brand assets, usage and provenance](docs/BRANDING.md) cover the scalable SVG, browser icons and touch icon.

## New in 0.0.2

Version 0.0.2 adds **batch bookmark organization** and **Undo/Redo** in both page editors. After importing bookmarks, select a page or all filtered results to move categories, add/remove tags and set favorites. Page drafts keep up to 60 history steps and are persisted with an explicit save. See the [user guide](docs/USER_GUIDE.md) and [batch API contract](docs/API.md#batch-bookmark-organization).

See the [0.0.2 changelog](CHANGELOG.md#002---2026-10-24) for the full changes and upgrade requirements.

### One-time setup language

A new instance determines its language once. An explicit `--language en|zh-CN` or `LINGSHU_LANGUAGE` saves that choice before setup. With no language specified, the first page asks for English or Simplified Chinese; confirming saves it before opening the setup form. Setup, sign-in, Home, Admin and optional example bookmarks then use the same language. The example collection has a preview and no separate language selector.

The saved language survives restarts. A conflicting valid startup value is logged and ignored; it does not switch the instance or stop the service. Existing initialized installations keep the language supplied when they first upgrade, or their previous `zh-CN` default when none is supplied, without reopening language selection. Back up the database and keys before applying the new **`007_instance_language.sql`** migration. See [language operation](docs/USER_GUIDE.md#choose-the-instance-language) and [storage](docs/STORAGE.md).

Version 0.0.2 restores the spacing around shared form notices and explains the five built-in component data formats in the source editor. A data source uses an installed format; adding a new format requires application development.

## Quick start

These instructions target **[0.0.2](VERSION)** and **Linux amd64 (x86-64)**. Use **[Release v0.0.2](https://github.com/zhigege666/Lingshu-Home/releases/tag/v0.0.2)** for the Linux executable, Docker image archive, source and checksums. Choose one installation below; all use embedded SQLite by default and need no external database or other Home service.

### Docker image

Run the latest published stable image with Docker:

```bash
docker run -d --name lingshu-home \
  --restart unless-stopped \
  --stop-timeout 30 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  -p 127.0.0.1:5180:8080 \
  -e LINGSHU_LANGUAGE=en \
  -v lingshu-home-data:/data \
  ghcr.io/zhigege666/lingshu-home:latest
```

`latest` follows the highest verified stable release; prereleases are excluded. To stay on this specific release, use `ghcr.io/zhigege666/lingshu-home:0.0.2` instead. A moving tag does not update a running container: review the release notes, back up data, then pull and recreate it to upgrade.

Open **http://127.0.0.1:5180** on the Docker host. The named volume `lingshu-home-data` retains the database, instance keys and saved assets when the container is replaced. The image runs as UID/GID `10001:10001`; a custom bind mount at `/data` must be writable by that identity. To check startup, run `docker logs --tail=100 lingshu-home`.

### Linux amd64 release

Download `Lingshu-Home-0.0.2-linux-amd64.tar.gz` from the release, then extract and run it from its directory. Go and Node.js are not required:

```bash
tar -xzf Lingshu-Home-0.0.2-linux-amd64.tar.gz
cd Lingshu-Home-0.0.2-linux-amd64
./lingshu-home --language en --data-dir "$HOME/.local/share/lingshu-home"
```

Open **http://127.0.0.1:5180** on that computer. Leave the terminal open while using the service. The command keeps persistence outside the versioned release directory; reuse that data path after upgrading. Keep `web/dist` and `VERSION` beside the executable as supplied, and start from the extracted directory unless you explicitly configure their paths. Use `./lingshu-home -help` for server options.

Both examples bind access to the host's loopback address. For another computer, configure the published interface or an HTTPS reverse proxy and use that deployment address. An HTTPS reverse proxy supplies TLS; set `LINGSHU_SECURE_COOKIES=true` for that deployment. This setting requires HTTPS cookies and does not enable a TLS listener in Home.

### Unraid

Use the [Unraid template and installation guide](docs/UNRAID.md) for Docker Manager or Community Applications. The template maps host port `5180` to container port `8080`, keeps data at `/mnt/user/appdata/lingshu-home`, and explicitly runs as `99:100` for that appdata directory. It uses `latest` for stable releases. Existing installations pinned to `0.0.1` or `0.0.2` need a one-time Repository change to follow `latest`; a catalog template update does not change an installed container. The guide covers language, setup, backups, updates, version pinning and manual template installation.

### First-run setup

The commands above explicitly choose English, so a new instance opens setup in English. If no language was supplied, first select English or 简体中文 on the bilingual language page and confirm. A successful confirmation saves the choice before the setup form opens; an existing saved choice skips this page.

1. Enter a site name and choose an access mode. **Public browsing** (`public_read`) is the default: visitors can read published shared content, while maintenance requires an Owner. Personal spaces remain private.
2. Create the Owner in modes requiring an account. Home has no default administrator username or password. Usernames use 3–40 ASCII letters, digits, `.`, `_` or `-`; passwords contain 10–128 characters. The display name is optional. **Open editing** can run without an account; enable **Also create an administrator (optional)** to create an Owner during the same setup.
3. To start with examples, enable **Add example bookmarks** and expand **Preview the websites to add** if needed. The collection automatically matches the saved instance language; there is no separate language selector. Examples are off by default and are added only to the shared space.
4. Select **Create my Home**. A newly created Owner is signed in automatically. Open editing and Public browsing start on the shared space, whether or not examples were selected.
5. On an editable empty homepage, use **Add your first link** or **Import browser bookmarks** to open the corresponding admin workflow. **Admin** also provides link/category management, import/export and homepage settings.

Setup, sign-in, the homepage, Admin and the optional example bookmarks share the saved instance language. It remains fixed across restarts and cannot be switched in the UI. Home does not import personal browser data automatically. A selected, still-authorized space survives a full page refresh in the same browser tab; this preference is separate for signed-in and anonymous identities and is not synchronized across devices.

### Keep data and stop safely

For the Docker command above, use `docker stop lingshu-home` and `docker start lingshu-home`; its stop timeout is 30 seconds. For the Linux foreground process, press `Ctrl+C` and wait for it to exit. Neither procedure requires deleting data.

Before upgrading to 0.0.2, stop Home and back up the database together with its matching `csrf.key` and `integrations.key`. Migration 007 adds the persisted language; rolling back to 0.0.1 requires that pre-upgrade database/key backup together with the old application. Retain the same named volume or `--data-dir` when starting the new version. The source Compose deployment below uses its own project-scoped `home-data` volume; switching installation methods does not move data automatically. PostgreSQL also needs the local keys. Follow the [backup and migration instructions](docs/STORAGE.md) before an upgrade or downgrade.

For everyday operation, see the **[English user guide](docs/USER_GUIDE.md)** or **[中文使用手册](docs/USER_GUIDE.zh-CN.md)**. They cover accounts, link maintenance, bookmark and icon import, visual editing, themes, category linking, page content, language, integrations and recovery.

## Features

| Area | Capability |
| --- | --- |
| Frontend | React + TypeScript + Vite; built-in admin using public MIT-licensed REUI components |
| Backend | Go HTTP service; one service serves the built frontend, API, and MCP |
| Storage | Embedded SQLite by default; external PostgreSQL also supported, with versioned migrations for both |
| Navigation | Categories and nested folders, links, tags, favorites, multiple URLs per project, sorting, search, and JSON/HTML export |
| Admin | Fixed workspace, compact link/category tables, 25/50/100-row pagination, styled keyboard-accessible forms and inline validation |
| Bookmarks | Chrome/Netscape HTML file preview and import, folder hierarchy, duplicate handling, and limits |
| Homepage | Compact toolbar; cards/directory; light/dark/system; density; category navigation at top/left/right/bottom/hidden, with icon + text/icons/text and tree/flat modes |
| Composition | Dedicated homepage editor with component library/layers, selectable canvas and inspector; add, duplicate, hide, remove, move, resize and lock components in fixed regions or a 24-column grid |
| Themes | Classic and iOS inspired page themes; independent icon + text, minimal text and app-icon presentation per navigation/favorites component |
| Page content | Visually select all six header/footer alignment slots; edit text, links and removable branding in the same page draft; one explicit save/cancel/restore flow |
| Icons | 30 searchable offline Lucide icons, space-scoped libraries or image import, and default-on automatic website icons with a server cache and per-link manual override |
| Branding | Shared jade folded-house SVG; SVG/PNG browser-tab icons and a 180 px touch icon |
| Language | Instance-wide English or Simplified Chinese, selected once before setup and retained across restarts; example bookmarks match it |
| Access | Four modes; Owner/Member accounts, optional registration, private personal spaces, and shared spaces |
| Integrations | Typed external pushes and HTTP JSON polling; ICS calendar, Open-Meteo weather, metrics/status components, GitHub Traffic, scoped tokens and MCP |
| Component import | Public URL or JSON template preview, compatible local-source binding and explicit draft save; installed built-in renderers only |
| Distribution | Linux amd64 executable and Docker image; native Windows and macOS clients remain planned |

The navigation area remains the main content. Wide layouts target 2560 × 1440, with a compact search field and a responsive flow on smaller screens. Demo links are optional during setup; Home does not import personal browser data automatically.

## Screenshots

Historical `0.1.0-dev.1` development browser captures at 2560 × 1440, using [public demo bookmarks](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/tests/fixtures/demo-bookmarks.html). These views follow a real save and full document reload during acceptance; the original demo configuration was restored afterward. Existing Chinese category/bookmark text in the English interface is retained user content. See the [screenshot record](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/assets/screenshots/README.md) for capture states and mobile examples.

### iOS inspired theme · English interface

![Lingshu-Home English homepage with the built-in iOS inspired theme and app-icon navigation](https://raw.githubusercontent.com/zhigege666/Lingshu-Home/v0.0.1/assets/screenshots/home-ios-en-2k.png)

### Classic theme · English interface

![Lingshu-Home English homepage with the Classic theme, grouped navigation cards and favorites](https://raw.githubusercontent.com/zhigege666/Lingshu-Home/v0.0.1/assets/screenshots/home-brand-en-2k.png)

Editor captures currently available in the [screenshot record](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/assets/screenshots/README.md) use the Chinese interface and are labelled accordingly. For English editing instructions, see the [user guide](docs/USER_GUIDE.md).

Other language and mobile captures: [Chinese iOS theme](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/assets/screenshots/home-ios-zh-CN-2k.png) · [390 px mobile editing canvas](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/assets/screenshots/home-editor-mobile-zh-CN-390.png).

Earlier Classic, admin and preview captures remain available as historical examples in the [screenshot record](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/assets/screenshots/README.md).

## Build from source

The commands in this section require a source checkout, not the extracted Linux executable bundle. Get the release source with Git:

```bash
git clone --branch v0.0.2 --depth 1 https://github.com/zhigege666/Lingshu-Home.git
cd Lingshu-Home
```

That checkout pins **0.0.2**, including the language, batch organization and draft-history behavior described here.

### Build a Docker image from the checkout

With Docker and the Compose plugin installed, build and start the SQLite deployment:

```bash
LINGSHU_LANGUAGE=en docker compose up -d --build
```

Open **http://127.0.0.1:5180** on the Docker host. This Compose file builds `lingshu-home:local`, publishes container port `8080` only on host loopback port `5180`, and mounts its project-scoped `home-data` volume at `/data`. Both Compose files allow 30 seconds for shutdown. Keep the same project identity and volume for later starts.

To use an existing PostgreSQL server, create a dedicated Home database with permission to apply its migrations and supply a connection URL reachable from the container:

```bash
export LINGSHU_DATABASE_URL='postgres://home_user:replace_me@db.example:5432/lingshu_home?sslmode=require'
LINGSHU_LANGUAGE=en docker compose -f compose.postgres.yaml up -d --build
```

Use the PostgreSQL file on its own and retain its private database environment on later commands. It does not create a PostgreSQL server and still needs the data volume for instance keys. Selecting another provider does not migrate existing data. See [storage and backup instructions](docs/STORAGE.md).

Imported icons and website caches live in the selected database; no separate upload volume is required. Migration **`005_auto_icons.sql`** stores automatic-icon settings, link intent and bounded pending work; **`006_network_routing.sql`** stores default-on browser route selection and server proxy configuration for both providers. Existing icons, ordinary additional links and earlier migration checksums are preserved. Returning to a binary that predates an applied migration requires its matching database/key backup, not just replacing the executable or image.

Version 0.0.2 applies **`007_instance_language.sql`** to both providers, storing the fixed instance language. Its Compose files and development helper leave an omitted language unset, so a new instance can ask for it in the first-run page.

Builds use pinned dependencies and base image digests. `NODE_IMAGE`, `GO_IMAGE`, `RUNTIME_IMAGE`, and `GOPROXY` build arguments can select a reachable mirror while retaining verified image digests.

### Build and run locally

Build prerequisites: **Go 1.26.8**, **Node.js 24.19.0 with npm**, and **Python 3.10+**.

```bash
python3 scripts/dev.py build
python3 scripts/dev.py start --language en
python3 scripts/dev.py status
```

Open **http://127.0.0.1:5180**. The build includes the frontend, a Go server binary, and original dependency license notices. The helper's default persistent directory is `data/` in the checkout.

```bash
python3 scripts/dev.py stop
# Foreground alternative:
python3 scripts/dev.py run --listen 127.0.0.1:5180 --language en
```

The background helper is for Linux development and identifies the process it started before stopping it. It does not install a system service. `LINGSHU_GO`, `LINGSHU_NODE`, and `LINGSHU_NPM` can point to portable toolchains. For frontend development, run the API on `127.0.0.1:5180`, then run `npm run dev` in `web/`; Vite proxies application API requests to that service.

### Runtime configuration and language

These options apply to **0.0.2**. A new instance can choose its language once at startup or on the first-run page; a saved choice takes precedence.

| Variable | Default / meaning |
| --- | --- |
| `LINGSHU_LISTEN` | Standalone server: `127.0.0.1:5180`; supplied image: `0.0.0.0:8080` |
| `LINGSHU_DATA_DIR` | SQLite and instance keys; default `data/`, or `/data` in the image |
| `LINGSHU_STORAGE_PROVIDER` | `sqlite` or `postgres`; default `sqlite` |
| `LINGSHU_DATABASE_URL` | PostgreSQL connection string; required for `postgres` |
| `LINGSHU_WEB_DIR` | Built frontend directory; standalone `web/dist`, image `/app/wwwroot` |
| `LINGSHU_VERSION_FILE` | Product `VERSION` file; `/app/VERSION` in the image |
| `LINGSHU_LANGUAGE` | `zh-CN` or `en` for an instance without a saved language; omitted/empty asks once during first setup; a saved language takes precedence |
| `LINGSHU_SECURE_COOKIES` | Whether browser cookies require HTTPS; default `false` for local HTTP |

The quick-start Docker command selects its language with `-e LINGSHU_LANGUAGE=en`. The release executable accepts `./lingshu-home --language en`; the source-built binary accepts `./dist/lingshu-home --language en`. For an instance without a saved language, explicit flags take precedence over environment values. The accepted nonempty values are `en` and `zh-CN`; omission or an empty value leaves a new instance's choice to the first-run page.

Once saved, the language is fixed for that database. Changing a startup parameter or container environment does not replace it: Home logs a warning for a conflicting valid value and keeps running in the saved language. There is no later UI switch or automatic browser-language override. Existing names and custom text stay unchanged; new default spaces/pages and optional starter links follow the saved language. Before upgrading an initialized 0.0.1 instance, keep its original language in the startup configuration, especially `en` for an English instance. The first 0.0.2 start saves that value; without one it uses the old `zh-CN` default. [Language operation](docs/USER_GUIDE.md#choose-the-instance-language).

## Access modes

| Mode | Viewing | Maintenance |
| --- | --- | --- |
| `open_edit` | Published shared content without sign-in | Anonymous maintenance of that content; creating an Owner is optional |
| `public_read` | Published shared content without sign-in | Owner sign-in to maintain shared content and their own personal space |
| `private_single` | Owner sign-in required | One Owner maintains the instance |
| `private_multi` | Account sign-in required | Members maintain their own personal space; the Owner manages accounts and shared content |

`public_read` is the initial setup default. Self-registration is a separate option, off by default and available only in multi-user mode. An Owner cannot open another user's personal space. Personal spaces remain private when modes change; mode changes revoke existing authorization sessions and tokens.

Browser writes use session-bound CSRF protection. Integration credentials and scoped personal access tokens require an account even when navigation allows anonymous maintenance. Starting without an account does not create an unrestricted anonymous MCP or credential-management endpoint.

## Data sources, panels, and themes

The composition model is **data sources + display components + layout and themes**. The local navigation dataset is authoritative application data. Removing a panel, changing a preset, or moving category tabs preserves links and categories.

The two bundled page themes are **Classic** (`builtin/dashboard`) and **iOS inspired** (`builtin/ios`). Switching a theme changes its ID while preserving the page's sources, components, placements, custom content and appearance settings. This differs from applying a layout preset, which explicitly replaces the draft's component arrangement. Navigation and favorites each choose **Cards / Directory** independently from **Theme default / Icon + text / Minimal text / App icons**. An omitted `linkAppearance` follows the theme; an explicit choice stays in place when switching themes.

Select **Edit page** on an editable homepage to enter its dedicated workspace. The ordinary header is replaced by an editing toolbar; the left rail contains **Layers** and **Add**, the center is the live canvas, and the right rail edits the selected page, component or header/footer slot. Smaller editor windows use drawers. Add search, category navigation, favorites, navigation, GitHub Traffic, calendar, weather, metrics or service status; the data components require a compatible configured source; duplicate, hide, remove, reorder or change its source. Components can use fixed regions or a 24-column grid. Dragging, size controls, content height and locks adjust presentation without changing link ownership; narrowing the browser does not overwrite desktop coordinates.

Category navigation is itself a component. It can occupy top, left, right, bottom or hidden placement and supports icon + text, icons only or text only, tree/flat presentation, counts and folding. Search/category/link components connect through friendly interaction groups. In ordinary browsing, folding is a page/component-specific browser-tab preference. During editing, whole-panel folding changes only the draft default.

All six header/footer slots can be selected on the canvas, including empty slots, and edited in the same inspector. Add or move plain text, HTTP/HTTPS links and built-in branding between left, center and right. The editor validates every slot, including disabled areas, and locates an invalid item before submitting. **Save page** writes the complete draft with a revision check; **Preview**, **Restore** and **Cancel** do not save it. The normal header returns in preview; account and management controls remain owned by Home. The default branding appears in the footer's right slot and can be moved or removed.

The admin retains an alternative form-based page editor, including exact placement fields and **Preview homepage** at 2560 × 1440, 1920 × 1080, 1600 × 900 or 2560 × 1080. Both preview paths render authorized source projections; they do not trigger upstream synchronization or invent missing data. [Homepage editing, preview and page content](docs/USER_GUIDE.md#5-arrange-the-homepage).

Link/category pagination limits mounted rows while retaining the current authorized snapshot in the browser; it is not server-side pagination. Homepage viewing controls remain temporary, while link stars and explicit page saves persist their corresponding data. [Persistence behavior](docs/USER_GUIDE.md#know-which-controls-save-data).

The component/source iteration adds a [public template import and data contract](docs/COMPONENTS.md). A template can configure an installed renderer; it does not execute a webpage or install remote JavaScript. Calendar, weather, metric and status sources keep one bounded latest snapshot, and an empty polling schedule has no periodic wakeup. Chinese and English setup packs contain different curated links; Setup chooses the matching collection automatically from the saved instance language.

**Edit page → Add → Dashboard presets** provides Personal overview, Service operations and Data summary layouts. Choose compatible existing sources for the components you want, or explicitly skip a component. Applying a preset replaces the component layout in the unsaved draft while retaining the current theme, page content and valid navigation sources; **Save page** persists it. Presets do not start collectors or insert example values. [Preset layouts and integration guide](docs/DASHBOARDS.md) · [Versioned data examples](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.2/examples/dashboard-data/README.md).

Two extension types are part of the contract: typed panel renderers and full-page themes. Installing arbitrary third-party theme packages, knowledge-base connectors, and general real-time adapters are future work. The admin and login pages remain host-owned interfaces.

### Icon libraries and website icons

Link and category editors share a searchable icon picker. Choose from 30 bundled Lucide icons, import a schema-versioned JSON library, or import one PNG, JPEG or supported static SVG file. Imported libraries belong to the current space and retain their source/license information. A library still needed by saved content cannot be deleted if doing so would remove that content's last copy of an icon.

**Access and accounts → Automatically fetch website icons** defaults to on. New Web bookmarks and browser-bookmark imports use automatic mode: the bookmark saves first, then a bounded background queue fetches its public-origin icon. Selecting an image switches that link to manual mode; existing links and offline starter icons are preserved. Turning the switch off stops automatic work and retains saved images. A link's **Fetch website icon** action remains available for an explicit lookup.

Visitors read Home's authorized local images. Browser HTTP caching uses ETag revalidation; loading a homepage never triggers a website lookup or a third-party favicon proxy. The empty queue has no polling timer. Internal services can use imported images. Library imports/deletions and explicit website-cache writes persist immediately, while a link/category's manual selection is saved with its form. [Import instructions and limits](docs/USER_GUIDE.md#choose-or-import-icons) · [Icon storage, API and fetch rules](docs/ICONS.md).

### Network settings and internal/external routes

Admin → Network settings provides default-on browser route selection and a default-direct server outbound proxy. Bookmarks can explicitly declare internal/external alternatives. A click prefers an internal response within a bounded budget and falls back to an external or primary URL when detection is unavailable. Ordinary additional links do not participate, and an idle homepage does not scan the network.

An Owner can configure an HTTP, HTTPS or SOCKS5 proxy with encrypted, write-only credentials. It applies to server icon, template, calendar, weather and external-data fetches; bookmark navigation uses the visitor's own network. Component import can discover and select multiple compatible templates before preview/source binding. [Network configuration, protocol and limits](docs/NETWORK.md).

### External writes and MCP

Use scoped personal access tokens for external clients. `external-push` sources accept complete validated navigation, calendar, weather, metric or status snapshots with a request ID and an expected revision or monotonic sequence. Replaying the same request is idempotent; conflicting or stale updates are rejected. External snapshots do not overwrite the local navigation dataset.

MCP is served at **`/mcp`** using Streamable HTTP and calls the same authorization and business logic as the HTTP API. Tools cover authorized navigation, bookmarks, pages, data sources, and synchronization. See [API reference](docs/API.md) and [integration guide](docs/INTEGRATIONS.md) for scopes, request formats, and client examples.

### GitHub Traffic

The GitHub Traffic source polls on a schedule and supports queued manual refreshes. Its first complete successful capture becomes an immutable repository baseline. Daily UTC observations are retained locally beyond GitHub's rolling window, while missing days remain missing and unique visitor counts retain GitHub's aggregation semantics.

Configure the repository and a suitably scoped GitHub token in the admin interface. SSH access to a Git repository does not grant access to its Traffic REST API. No real repository baseline is bundled with Home. Tokens stay encrypted on the server and are never sent to homepage panels. Cached data remains available when an upstream request fails, with freshness and error status shown separately.

## Verification and maintenance

Run these commands in a source checkout; release-runtime checks are in the user guide.

```bash
python3 scripts/check_repository.py
cd server
go test ./...
```

The HTTP runner exercises fresh disposable instances and a real process restart. It refuses existing initialized databases and non-loopback targets. Go provider suites use six distinct fresh PostgreSQL databases through `LINGSHU_TEST_POSTGRES_URL`, `LINGSHU_TEST_INTEGRATIONS_POSTGRES_URL`, `LINGSHU_TEST_ICONS_POSTGRES_URL`, `LINGSHU_TEST_COMPONENTS_POSTGRES_URL`, `LINGSHU_TEST_COMPONENT_MIGRATION_POSTGRES_URL` and `LINGSHU_TEST_NAVIGATION_POSTGRES_URL`. The last three cover component lifecycles, component migration preservation/rollback and navigation batches; language and migration 007 cases use isolated schemas in the icon test database. HTTP acceptance uses its own databases. An unset PostgreSQL variable skips its suite and is not a passing provider check. See [test instructions and coverage](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.2/tests/README.md) and [provider isolation](docs/STORAGE.md#provider-validation).

Every change set maintains the changelog and relevant public documentation. `VERSION` is the only manually maintained product version. Build outputs and release tags derive from it. Release descriptions come from the matching dated changelog entry, and release automation requires the application validation gates before publication. Creating or pushing a tag is a separate release action.

Private design documents and visual explorations are excluded from Git, Docker contexts, frontend resources, and release artifacts. Public API and deployment documentation are maintained in `docs/`.

Tailwind class discovery is explicitly limited to `web/src`. Build-output directories, public assets and private documents do not influence generated styles. Source-file counts, output identity checks and browser timings belong to the specific run recorded in [tests/README.md](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.2/tests/README.md) and [PERFORMANCE.md](docs/PERFORMANCE.md), rather than a standing performance promise.

### Historical verification

The following paragraph records the earlier visual-editor/icon development iteration. It does not establish the complete verification result for 0.0.2; use the release-specific verification record for that scope.

The earlier visual editor passed eight real browser workflows in each interface language, including a deliberate save, full reload and revision-checked restoration. Icon import, persistence, reference protection and invalid-pack rollback passed in both languages; website retrieval and a repeat cache hit were verified against the TypeScript website. GitHub lookup still timed out in the validation environment. SQLite, isolated PostgreSQL databases and the Docker runtime were also checked; see the [verification record](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/tests/README.md) for each result's scope. The [performance report](docs/PERFORMANCE.md) compares the development build with its predecessor using twelve fresh desktop browser contexts. Earlier interface checks are retained as historical evidence.

## Documentation

| Resource | Link |
| --- | --- |
| 中文说明 | [README.zh-CN.md](README.zh-CN.md) |
| Everyday operation (English) | [docs/USER_GUIDE.md](docs/USER_GUIDE.md) |
| 日常操作（中文） | [docs/USER_GUIDE.zh-CN.md](docs/USER_GUIDE.zh-CN.md) |
| Performance methodology and results | [docs/PERFORMANCE.md](docs/PERFORMANCE.md) |
| API and page schema | [docs/API.md](docs/API.md) |
| Unraid installation and upgrades | [docs/UNRAID.md](docs/UNRAID.md) · [简体中文](docs/UNRAID.zh-CN.md) |
| Storage, migrations, backup/restore | [docs/STORAGE.md](docs/STORAGE.md) |
| Network proxy and internal/external bookmark routing | [docs/NETWORK.md](docs/NETWORK.md) |
| Dashboard presets and data handoff | [docs/DASHBOARDS.md](docs/DASHBOARDS.md) |
| Sources, external pushes, MCP, GitHub Traffic | [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) |
| Components, calendar/weather, template import and data contracts | [docs/COMPONENTS.md](docs/COMPONENTS.md) |
| Icon libraries, formats and website cache | [docs/ICONS.md](docs/ICONS.md) |
| Test instructions | [tests/README.md](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.2/tests/README.md) |
| Changes | [CHANGELOG.md](CHANGELOG.md) |
| Contribution rules | [AGENTS.md](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.2/AGENTS.md) |
| Bundled icon sources | [assets/icons/manifest.json](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.2/assets/icons/manifest.json) |
| Versioning and releases | [docs/RELEASING.md](docs/RELEASING.md) |
| Third-party notices | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

## License

Copyright 2026 zhigege666 and Lingshu-Home contributors.

Original code and documentation are licensed under [Apache License 2.0](LICENSE). Third-party components and assets retain their original licenses. The code license does not grant trademark rights to the project name or brand marks.
