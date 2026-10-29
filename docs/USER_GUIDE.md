# User guide

**English** | [简体中文](USER_GUIDE.zh-CN.md) | [Project README](../README.md)

This guide covers **Lingshu-Home 0.0.7**, using English interface labels. For a new instance, specify `en` at startup or select English on the first-run language page. The choice is saved once for the instance. Installation commands are in the [README](../README.md), technical contracts in [API.md](API.md), and verification with its actual scope in [tests/README.md](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.7/tests/README.md).

The application uses the jade folded-house project mark across its home, admin, account/setup and startup screens, page branding and browser-tab icon. This guide now covers the dedicated visual editor, Classic/iOS themes and icon libraries. The linked earlier logo/layout screenshots and their 192 Chinese / 218 English browser assertions are historical; current verification is recorded separately in [tests/README.md](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.7/tests/README.md).

## 1. Start and initialize an instance

Install the **Docker image or Linux amd64 release** using [Quick start](../README.md#quick-start). The release executable includes its frontend and needs no Go or Node.js. Choose embedded SQLite on a new instance for a standalone installation, or connect an external PostgreSQL database. Both quick-start examples preserve the database configuration and instance keys outside the replaceable application files.

For the source Compose alternative, obtain the matching checkout as described in the README, then run from its repository directory:

```bash
LINGSHU_LANGUAGE=en docker compose up -d --build
docker compose ps
```

Open `http://127.0.0.1:5180` on the computer running Home. The examples bind access to that host's loopback address. For another computer, use the address provided by the instance administrator after configuring the published interface or reverse proxy. The homepage, admin, API and MCP use the same service.

A new instance with no explicit or saved database selection opens storage setup first. Choose **SQLite** for an embedded database, or **PostgreSQL** and enter its host, port, database, username, password and TLS mode. Test the external connection, then confirm the selection. Testing does not save credentials, create tables or run migrations; confirmation validates again and initializes the selected target. Language and account setup follow only after storage is ready.

An existing valid SQLite instance, saved storage selection or explicit deployment configuration uses its original target without this prompt. A failed connection to the selected PostgreSQL target opens recovery: repair the connection and retry that target. Invalid local configuration or an incomplete old SQLite instance prevents startup instead of creating an empty replacement. Before storage is ready, `/health` and business APIs return HTTP 503 while the setup page remains available. Storage setup does not move data between providers. Preserve the data directory and any private `storage.json`; see [storage selection and recovery](STORAGE.md#first-run-storage-setup).

If Home displays **Set up Home**:

If startup did not specify a language, first select English or 简体中文 on the bilingual language page and confirm. Only a successful confirmation opens the setup form. An explicitly configured or previously saved language skips that page. The choice is saved immediately, even if account setup is finished later.

1. Enter a site name, separate from an individual page name, and select an access mode. **Public browsing** is the default: visitors can read published shared content, while maintenance requires an Owner. Personal spaces stay private.
2. Create the Owner in modes requiring an account. There is no default administrator username or password. Usernames use 3–40 ASCII letters, digits, `.`, `_` or `-`; passwords contain 10–128 characters. The display name is optional. In **Open editing**, **Also create an administrator (optional)** is off by default; enable it to create an account while keeping anonymous navigation maintenance.
3. Enable **Add example bookmarks** only if wanted, then expand **Preview the websites to add** if needed. The example collection automatically matches the saved instance language and cannot be switched. Examples are off by default, editable later, and added only to the shared space.
4. Select **Create my Home**. A newly created Owner is signed in automatically. Open editing and Public browsing open the shared space after setup; private modes open the shared space when examples were selected, otherwise the Owner's personal space.
5. Use **Admin** for management. An editable empty homepage also offers **Add your first link** and **Import browser bookmarks**, opening the corresponding admin flow directly in the current space.

If the setup request fails or its result is unclear, **Check setup status again** reads the server's current initialization and sign-in state. It does not resubmit the setup form or sign in with a retained password. If setup is still incomplete, the form stays available; if it completed, continue to the homepage or sign-in screen as directed.

If an existing instance opens its homepage or login screen, setup has already been completed. Continue using that instance and its existing data. Home does not import personal browser data automatically.

### Choose the instance language

[View the earlier English homepage capture](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/assets/screenshots/home-brand-en-2k.png). This historical image predates the visual editor and iOS theme. Existing category and bookmark names retain their original language.

The homepage, setup, login and admin use the same `en` or `zh-CN` setting. **Version 0.0.2 saves it once for the instance**, including the example collection, and provides no later UI switch or browser-language override. The following startup values select a language only while the instance has none saved.

| Deployment | English example |
| --- | --- |
| Published Docker image | Use `-e LINGSHU_LANGUAGE=en` in the complete README `docker run` command |
| Linux release, from its extracted directory | `./lingshu-home --language en --data-dir "$HOME/.local/share/lingshu-home"` |
| Source Compose / SQLite | `LINGSHU_LANGUAGE=en docker compose up -d --build` |
| Source Compose / PostgreSQL | `LINGSHU_LANGUAGE=en docker compose -f compose.postgres.yaml up -d --build`, retaining the database environment |
| Development helper | `python3 scripts/dev.py start --language en` or `python3 scripts/dev.py run --language en` |
| Built server, from the checkout root | `./dist/lingshu-home --language en` |

Use `zh-CN` instead for Simplified Chinese. Before a language is saved, an explicit `--language` takes precedence over `LINGSHU_LANGUAGE`. An omitted or empty value leaves a new instance at the first-run language page. The development helper and Compose files preserve that unset state. Confirming a language saves it to the instance database before the account form opens; reloading or restarting continues in that language. If confirmation returns an error, stay on the choice page and retry or read the current state rather than assuming it was saved.

After confirmation, changing parameters or container environment does not switch the language. A conflicting valid startup value produces a warning and the saved language remains in use; the service does not stop. There is no supported page or settings API for changing it later. The starter collection is displayed as the matching Chinese or English collection, with no additional selection. Existing stored names and custom text are not translated or renamed.

**Upgrading an initialized 0.0.1 instance:** back up the database and keys, and retain the original `--language` / `LINGSHU_LANGUAGE` value for the first 0.0.2 start, especially `en` for an English instance. The first start after migration 007 saves that language; if none is supplied, it preserves the old default `zh-CN`. An initialized instance does not reopen the language chooser. A database that has applied 007 requires its corresponding application; reverting to 0.0.1 requires the pre-upgrade database/key backup.

**Compatibility with 0.0.1:** that version had no first-run language page or persisted language and allowed independent example collections. Starting with 0.0.2, the saved instance language controls both the interface and examples.

### Choose the access mode

| Interface option | Mode | Who can view and maintain content? |
| --- | --- | --- |
| Open editing | `open_edit` | Published shared navigation is readable and editable without signing in. Setup can optionally create an Owner at the same time. |
| Public browsing | `public_read` | Anyone can read published shared navigation. The Owner signs in to maintain it and their own personal space. |
| Private navigation | `private_single` | The Owner signs in to view or maintain the instance. |
| Multiple users | `private_multi` | Accounts sign in. Each Member maintains a private personal space; the Owner maintains shared content and manages accounts. |

**Public browsing** is the setup default. Personal spaces remain private in every mode. The Owner cannot open another user's personal space. Self-registration is a separate setting, initially off, available only in multi-user mode.

Database selection happens before language/account setup on an unconfigured 0.0.6 instance. Explicit deployment settings and existing storage continue to take precedence. Choosing another provider does not convert existing data; follow [STORAGE.md](STORAGE.md) for configuration and recovery.

### Add an account after account-free setup

In an ownerless **Open editing** instance, open **Site settings**, enable **Also create the first administrator (optional)**, enter a username, optional display name and password, and select **Save access settings**. Keep Open editing or choose an account-required mode in the same form; switching modes twice is unnecessary. A successful creation signs you in as the new Owner and retains shared content. Open editing continues to allow anonymous navigation maintenance, while the account can manage integrations and other account-required features.

External source configuration, Home access tokens and MCP always require an account. Anonymous local navigation maintenance does not grant credential-management access. Once an Owner exists, global access settings are maintained by the Owner.

## 2. Find the right space and management page

Open **Admin** from the homepage, or append `/#/admin` to your instance address. Where multiple spaces are available, use **Current space** beside the account menu in the admin top bar, or the space selector on the homepage. Check it before adding content or importing bookmarks.

Since 0.0.4, Home remembers the last successfully loaded space separately for each account and the anonymous identity in this browser and site origin. It survives reloads, independent new tabs and browser restarts while browser data is retained. When signed in, use **Default opening space** beside the space selector to choose **Remember last space** or a fixed accessible space. Choosing **Remember last space** clears the fixed default without changing the currently displayed space.

A successful manual selection in the current tab takes priority, including after a reload. Otherwise Home chooses the fixed default, then the last successfully loaded space, then the server default or first accessible space. Signing out clears the tab's manual override while retaining that account's browser preference for a later sign-in. Deleted or inaccessible preferences are discarded; a failed request never records its destination as the last successful space. If browser storage is unavailable, sign-in and space switching still work. These preferences belong to the current account in this browser, do not sync to another device and do not change account permissions. Examples belong to the shared space; an editable empty homepage offers **Add your first link** and **Import browser bookmarks** directly.

| Menu | Typical task |
| --- | --- |
| Link management | Create, edit, search and delete local links |
| Category management | Organize nested categories and their sort order |
| Layout and theme | Configure the page, presets, category navigation and component bindings |
| Import and export | Import browser HTML bookmarks and export the current space |
| Space settings | Rename the current space; the Owner can manage shared-space public browsing |
| Sources and MCP | Configure external sources and create or revoke your access tokens |
| Site settings | Site name, access mode, registration, first-Owner creation when ownerless and Owner login-retention policy |
| My profile | Change your display name/password and manage your signed-in browsers |
| Network settings | Automatic internal/external selection and the Owner-managed server proxy |
| Member management | Create and manage Members; visible to an Owner in multi-user mode |
| About Home | Check application/frontend versions and project information |

The top bar carries the current page title and the space/account controls. The sidebar groups Content, Current space and Site administration. Space settings is separate from import/export; personal spaces remain private, and shared-space publication still follows the site access mode. Optional explanations open from help icons using pointer or keyboard; Escape/outside click closes them, while validation errors and operation results stay visible.

The admin uses a fixed-height workspace. Link/category tables scroll inside their content area; headings, search, actions and pagination stay visible. Settings use their own content area and the layout editor keeps save/cancel controls at the bottom. The whole browser document does not grow with every table row.

### My profile and browser sessions

Open the account menu → **My profile** to change your display name; the sign-in username stays fixed. A password change needs the current password and a different new password of 10–128 characters. The current browser receives a new session using its permitted login mode; all prior browser sessions and API/MCP tokens for that account become invalid. Changing only the display name does not end sessions. Unsaved input is retained for conflict review, and leaving prompts you to save or discard it.

Login, registration and account-creating setup offer **Login retention**. The initial default is remembering the browser for 30 idle days; the Owner can change the choices in **Site settings → Login retention**:

| Choice | Behavior |
| --- | --- |
| Temporary | A fixed 12-hour server session. The cookie is not persistent, but browser session restoration can retain it; closing a window is not a guaranteed sign-out. |
| Remember browser | 7, 30 or 90 idle days, limited by the Owner's maximum. Real interaction in a visible page renews it at most once per 15 minutes; background polling and API/MCP activity do not renew browser access. |
| Until I sign out | Available only when the Owner enables it. No server idle deadline; the browser cookie lasts up to 365 days and is renewed on eligible activity. Sign-out, revocation, security changes or cleared browser data can still end access. |

Existing temporary sessions keep their old deadlines; sign in again to choose another mode. Tightening the idle limit shortens existing remembered sessions; later relaxing it does not restore their old duration. Disabling until-sign-out revokes those sessions and may sign out the current browser.

In **My profile → Signed-in sessions**, revoke an individual browser, sign out other sessions or end this session. Save or cancel profile/password changes before doing so. Session revocation affects browser logins; separately issued API/MCP tokens remain valid until their own revocation, expiry or an account/security change. Device descriptions come from browser information and are not verified hardware identities.

### Pagination and search

Link and category lists start at **25 rows per page**. Select 25, 50 or 100 at the bottom, and use the first/previous/next/last controls. Search returns to page 1; changing space or section does the same. Deleting the last row of a final page moves the list back to an available page.

This is pagination of the authorized navigation snapshot already loaded by the browser. It limits mounted table rows; it is not server-side paging, streaming or an infinite “load more” list. Link-list search covers title, main URL, description and tags. Category search includes the parent path. Reload the page to read changes made elsewhere.

## 3. Maintain categories and links

### Edit categories and links on the homepage

Since 0.0.7, the homepage **Edit** action opens a content draft for readers with maintenance permission:

1. Click a category name to rename it inline, or use its settings button for its icon/parent. Handles reorder sibling categories; the whole subtree follows a parent.
2. Click a link name to open a compact inspector for title, URL, category, tags and favorite state. Expand additional fields for description, icons and alternate URLs. The inspector also shows recorded lifetime clicks and last-click time.
3. Drag link handles within a category or into another, empty or Uncategorized group. Search and page through folders without truncating hidden records or losing their relative order. Favorite cards edit the same original link without a separate favorite order.
4. Keep all changes in one memory draft, then Undo/Redo, Cancel or **Save**. Ctrl/Cmd+S uses the same save. Enter/Shift+Enter moves between fields without interfering with IME composition. Position buttons provide a non-drag alternative.
5. One save submits fields and order atomically. Validation retains input; conflicts or an uncertain response require **Read latest and compare**. Explicitly choose conflicts; already committed changes are not replayed. A successful save with failed refresh keeps the confirmed result visible and offers another read.

A draft accepts 500 patch/move operations; editing fields and moving one record can consume two operations. Creation, deletion, imports and bookmark usage notes keep their established management paths. Drafts are memory-only: reload/tab close can lose them; sign-out/account changes clear old private drafts. Handle unsaved changes before switching spaces or choosing **More editing options → Adjust layout**. Content editing does not save layout, theme or component placement.

### View click statistics

Signed-in readers can select **Statistics** on Home, choose the last 7/30/90 days or a custom UTC range, filter categories and sort by range clicks or last click. The table includes period/lifetime counts and last-click times, including zero-click links. Summaries cover the full filtered population, independently of pagination. Link inspectors read the same statistics.

Counts represent local bookmark activations, including alternate entrances, keyboard Enter and modified/middle clicks; they are not proof of a successful destination load or unique visitors. Editing, previews, hover, probes and folder browsing do not count, and external snapshots are excluded. Reporting failures do not block navigation. Recording begins at the upgrade baseline; earlier usage is unknown and the first/current day may be partial. Categories describe current membership; deleting a link removes its counters.

Agents with this space's `navigation:read` scope can use `navigation_click_stats` for date comparisons, category analysis and zero-click records. Preserve the returned recording baseline and tracked-day flags when interpreting results. Aggregate reads require sign-in and space read permission; anonymous public-shared browsing can report clicks but cannot read statistics. The statistics tables store no visitor identities, IPs, browser identifiers or referrers. See the [API counting contract](API.md#link-click-statistics).

### Categories

1. Open **Category management → Add category**.
2. Enter **Category name** and choose an icon from the built-in collection or an imported library, as described below.
3. Leave **Parent category** as **Top level**, or select an existing parent. The parent selector excludes the category itself and its descendants while editing.
4. Enter **Sort order** and save. Lower numbers appear first; use gaps such as 10, 20 and 30 if you expect to insert more categories later.

Use the pencil action to rename, move or reorder a category. Changing its parent changes the hierarchy; switching the homepage's tree/flat presentation only changes how the same hierarchy is displayed. The resulting hierarchy supports at most 32 levels.

A category containing links or child categories cannot be deleted. Move its links to another category or **Uncategorized**, move or remove its child categories, then use the delete action and confirm. Deletion has no recycle-bin workflow in this version.

### Links and multiple project entrances

1. Open **Link management → Add link**.
2. Enter **Link name** and a complete `http://` or `https://` address in **Primary URL**. Select a category or **Uncategorized**.
3. Add an optional description and comma-separated tags. Keep the default automatic icon mode, or choose a built-in/imported icon to use a manual selection.
4. Use **Add to favorites** for frequently used entries and set their sort order.
5. For automatic selection, use **Internal and external access → Add internal route / Add external route**, with a label, complete URL and read-only probe path. Keep documentation, administration pages and other manual destinations in **Additional URLs → Add URL**; unmarked entries do not participate in automatic routing. A link supports up to 12 entries across these groups. Cross-origin probes require the service to allow Home through CORS; otherwise Home retains the external/primary fallback. See [Network settings](#network-settings-and-internalexternal-access).
6. Select **Save link**.

The table keeps long content compact. It shows the main URL, up to two tag chips and two additional entrances, plus a count for remaining items. Hover the count for its summary or open the editor for all values. No stored tags or URLs are discarded by the compact table.

Use the pencil to edit; the trash action opens a compact confirmation beside its button before deleting the link and its additional entrances from the current space. Link/category confirmations keep keyboard focus on the cancel action initially and can close with Escape. Long edit forms use a fixed header/close control, a scrolling body and visible footer actions; link basics and icon selection share two columns on wide screens. Links only accept HTTP/HTTPS; executable bookmarklets, browser-internal addresses and file URLs are not supported.

On an editable homepage, the star button also updates a local link's favorite status immediately. External snapshot links are maintained by their source, so their favorite data cannot be changed through the local-link star action. A favorite appearing in both the favorites panel and the full navigation is one stored link shown twice.

### Edit categories and links in their lists

Choose **Edit list** in Category management or Link management. Edit category names, parents and sort order, or link names, primary URLs, categories, tags, sort order and favorites directly in rows. Both lists share an account/space-specific draft across pages. **Save all** commits up to 500 changed records together; any validation or revision failure leaves the whole batch unapplied.

Use a row's **More settings** for icons, descriptions and additional URLs, then **Apply to draft** before the final save. These forms do not import an icon library or fetch website icons immediately. Untouched fields, including existing bookmark usage notes, stay intact; edit usage notes in the individual bookmark editor. While editing, rows retain their baseline order and search membership so a changed name or order does not move the focused row.

**Changed only**, **Undo** and **Redo** help review the batch. History retains up to 40 edit groups; table Ctrl/⌘+Z and Shift+Z use that history, while search/detail text inputs retain their own input behavior. Tab/Shift+Tab follow normal controls. Enter/Shift+Enter move between single-line inputs without interrupting IME composition; the last row does not automatically change pages or save.

Leaving, changing space or opening another settings page offers save and leave, discard and leave, or continue editing. Drafts live only in the current tab's memory; save before refreshing or closing. On a conflict or uncertain network result, use **Read latest and compare**. Nonconflicting fields merge, genuine conflicts require a choice, and changes already committed despite a lost response are removed from the draft without an automatic repeat write. Deleted records cannot be restored through this editor.

After session expiry, the previous account's content is hidden until the same account signs in again and still has access. A retained draft can then resume. Explicit sign-out, switching accounts or confirmed loss of read permission clears it. These navigation edits are separate from the homepage layout draft and its Undo/Redo history.

### Organize selected links

After importing, open **Link management** and search for the links to organize:

1. Row checkboxes select individual links. The header checkbox selects **this page** only. Selection is retained when changing pages or page size.
2. **Select all results (count)** explicitly selects the current search results, up to 500 links per batch. Narrow your search if it contains more than 500 results. The toolbar always shows the selected count.
3. Choose **Move category**, **Edit tags** or **Set favorites**. Move to an existing category or **Uncategorized**; add/remove only the specified tags; add/remove favorites.
4. Check the space, selection count and expected change count, then select **Apply to N links**. Links already matching the choice stay unchanged.
5. Completion reloads the list and clears the selection. Search changes, refresh, menu/space/identity changes and lost edit permission also clear it.

Each link supports at most 32 tags of at most 40 characters each. Separate tags with commas; whitespace is trimmed and matching is case-sensitive. If another window, import or automatic icon completion changes the navigation revision, the dialog explains that this request made no changes and offers **Refresh and select again**. A batch either commits completely or rolls back completely.

These actions write navigation records immediately and are outside page draft history. For field-update actions, only the selected category, tag or favorite field changes; URLs, additional URLs, icons and automatic/manual icon mode are preserved. Since 0.0.4, **Delete selected** is also available. Its button-side confirmation shows the space and selected count; **Delete N links** permanently removes those links and their additional URLs. Cancel/Escape/outside-click closes the confirmation before submission. A busy request cannot be submitted twice. If deletion succeeds but list refresh fails, the interface reports the completed deletion and asks for a reload; it does not offer the same deletion again.

### Choose or import icons

Link and category forms use the same icon picker. **Built-in** provides 120 offline Lucide outline icons in eight groups, expanded from the 30 in 0.0.2. Choose **Icon group** to browse, or search Chinese/English names, IDs and aliases such as NAS, Docker, AI and video. A search covers all groups; choosing a group clears the search. The grid displays names, 24 icons per page and a preview of the selected icon. **Clear icon search** restores the complete collection. **Use default** returns the form to the normal link/category fallback. Selecting an icon changes the form draft; use **Save link** or the category's save action to apply it.

Since 0.0.6, built-in icons, imported-library choices and the selected preview use 24 × 24 CSS pixels. Fixed cells and two-line labels keep icon rows aligned, while hover/focus retains the full name. This changes picker layout without rewriting icons or saved references.

To use your own image or collection:

1. Check the current space, then open the icon picker's **Import** tab.
2. Select one `.png`, `.jpg`/`.jpeg` or supported static `.svg`, or a Schema 1 `.json` icon library following [ICONS.md](ICONS.md#import-a-pack).
3. Check **Library name**, the optional **Source URL**, and the required **License or ownership notice**. Keep the actual original notice for third-party assets. Source URL records provenance; importing does not fetch it.
4. Select **Import and select** for a single image, or **Import library** for a collection. A single imported icon is selected in the form; for a collection, choose an entry under **Libraries**.
5. Save the link/category form to apply its selected icon.

Single-image input is at most 256 KiB and 512 × 512; SVG has a stricter 64 KiB input limit and requires a positive bounded `viewBox`. Libraries contain 1–64 images with at most 4 MiB decoded image data. A space accepts at most 32 libraries. The server checks the real format and rewrites raster images; SVG supports static geometry without scripts, external references, text, gradients or embedded images. Convert complex SVG to PNG first. ZIP, icon-font and CSS packages are not accepted. Full per-space limits and a JSON example are in [ICONS.md](ICONS.md).

Under **Libraries**, choose a library, search its entries, inspect **Source and license**, or refresh the list. Deleting requires its inline confirmation. If deleting the last retained copy of an icon would break a saved link, category, page or source snapshot, Home rejects the deletion; replace those saved references first. Another library or website cache can retain an identical image.

### Fetch a website icon

**Site settings → Automatically fetch website icons** defaults to on. New links and browser-bookmark imports use automatic mode: Home saves the bookmarks immediately, then fetches supported website icons in the background. Choose **Refresh list** in link management or **Refresh content** on a navigation-only homepage to display completed results. There is no automatic navigation polling loop.

The link form distinguishes automatic and manual modes. Selecting a built-in/library image, **Use default**, or an explicit fetched image makes the link manual, so background work cannot replace your choice. Choose automatic mode and save to opt a link in again. Existing links and the offline starter collection retain their original images after upgrade.

Turning the instance switch off clears queued work, cancels/discards in-flight automatic results and keeps saved images. Explicit lookup still works. Turning it back on affects subsequent saves/imports; it does not scan old links. Once the instance has an Owner, that account controls this setting. An ownerless Open editing instance can configure it without creating an account. Changing only the icon switch keeps current sessions signed in.

In a link form, enter a complete primary URL and select **Fetch website icon**. Home requests the website's origin page, checks its declared icon candidates and `/favicon.ico`, validates the image, and returns a local selection. It does not forward your bookmark's path, query or fragment. Save the link to apply that selection.

Homepage visitors only load Home's authorized local images; there is no visitor-triggered missing-icon lookup or Google/other favicon proxy. Since 0.0.4, Home accepts automatic and explicit lookup from public or reachable LAN HTTP/HTTPS origins, including custom ports. The initial hostname may use RFC1918/ULA addresses or a resolvable LAN name; cross-host redirects/candidates must remain public. Home must be able to resolve/reach the server, and HTTPS must pass system certificate verification. For login-only or unsupported websites, use a local import or bundled icon. PNG, JPEG, the supported static SVG subset and bounded common ICO encodings are handled; not every site's icon format is supported. Failure or a full queue leaves the bookmark usable with its saved/fallback image.

Successful results are cached for 24 hours. Initial failures are cached for 30 minutes; a failed refresh preserves a previous good image. A later eligible save or explicit request after expiry can refresh it; expiry alone does not start work. Only one remote icon lookup runs at a time per instance, so retry after the current request finishes if the manual picker reports a busy service.

The selected Home database stores the actual image bytes and per-space cache. Browsers reuse image content through private HTTP caching with permission revalidation, rather than keeping the only copy in browser storage. Clearing browser data or using another device does not erase your saved images. An empty automatic queue has no periodic timer, and it needs no separate cache service.

**Imports, confirmed library deletions and website-cache writes take effect immediately in the current space.** Canceling the link/category form only discards its icon selection; it does not undo those library/cache operations. These actions use the current space's maintenance permission, including anonymous maintenance in **Open editing**, plus the normal browser CSRF checks. Personal images stay private to their space.

## 4. Import Chrome bookmarks

### Export a file from Chrome

In desktop Chrome, open its menu, go to **Bookmarks and lists → Bookmark Manager**, then use the manager's menu to export bookmarks. Save the resulting HTML file somewhere you can find again. These steps follow [Google's bookmark export instructions](https://support.google.com/chrome/answer/96816?hl=en).

Home imports the file you choose. It does not connect to Google account synchronization or read a browser profile automatically.

### Preview and import in Home

1. Choose the destination space.
2. Open **Import and export → Choose bookmark file**, or **Link management → Import**.
3. Select the exported `.html` or `.htm` file.
4. Choose **Skip duplicates** or **Keep duplicates**. Skipping is the default.
5. Select **Import into category**. **Root** retains the exported folder structure at the space root; selecting a category puts the imported structure beneath that category.
6. Select **Preview file** and check totals, invalid URLs, duplicates and folder paths.
7. Select **Import bookmarks**. Read the imported/skipped result and inspect the resulting links and categories.

| Import detail | Behavior |
| --- | --- |
| File size / link limit | At most 2 MiB of UTF-8 bookmark HTML and 10,000 links |
| Folder depth | At most 32 resulting levels, including the destination category path |
| Preview | Shows up to 200 entries; totals cover the whole file |
| Duplicate identity | Canonical URL against existing links in that destination space and earlier entries in the file |
| Skip | Leaves matching existing links intact; it does not update their names or categories |
| Keep | Adds valid repeated URLs as separate links |
| Invalid URLs | Counted separately and not imported |
| Changing file/options | Clears the old preview; preview again before confirming |

“Valid” includes entries also counted as duplicates. Do not add those counts together. Preview is read-only; import reparses and rechecks the current destination before writing. A wholly rejected file does not leave a partial import. For a repeated skip import that creates no new links or folders, the data revision does not advance.

Other browsers may export compatible Netscape-style HTML. Home's JSON export is not accepted by this HTML importer. HTML export represents additional project entrances as separate bookmarks, so reimporting that HTML does not reconstruct the original multi-entrance grouping.

## 5. Arrange the homepage

The page is composed from source bindings, components and placements. Changing layout does not reassign or delete links and categories. Each space currently has one managed homepage. Both the visual homepage editor and the admin page editor save the same page configuration; third-party theme installation and a multi-page library remain future work.

### Edit directly on the homepage

With edit permission, choose **More editing options → Adjust layout** on the homepage. The ordinary site header is replaced by a dedicated editing toolbar, so the workspace is available for composition:

| Part | Use |
| --- | --- |
| Top toolbar | Open the component library, undo/redo, preview, restore, cancel or save the page; check **Unsaved / No changes** |
| Left rail → Layers | Select the page appearance, an existing component, or a header/footer slot; hidden and locked components remain listed |
| Left rail → Add | Add a component, or select Header/Footer to edit page content |
| Center canvas | See the current draft and select components or any of the six header/footer slots, including empty slots |
| Right inspector | Edit the selected object's settings without opening a separate management page |

In smaller editor windows the side rails become drawers, opened with **Add component** and **Properties**. Close a drawer or use **Back to canvas** to inspect the result. The draft remains in memory. Closing a drawer does not save or discard it.

The search box remains an editable component in the canvas while the ordinary header is hidden. Category navigation is also a selectable component: click its edit label or select it under Layers. Account controls and the site's ordinary identity header remain owned by Home; the configurable header/footer content described below is separate.

### Undo, redo and save boundaries

The homepage toolbar and the bottom of **Layout and theme** both provide **Undo/Redo**. History covers page appearance, themes, components, placements, bindings and header/footer content; the admin editor also includes the page name.

- A drag or resize is one step. Consecutive edits in the same focused input merge while pauses remain under 750 ms; leaving the field starts a new step.
- Up to 60 steps are kept. Editing after undo clears the old redo branch. Returning to the saved content clears the unsaved-changes state.
- Use `Ctrl/⌘ + Z` to undo and `Ctrl/⌘ + Shift + Z` to redo; Windows/Linux also support `Ctrl + Y`. Inputs retain native text undo. Visible dialogs, homepage preview, active dragging and saving do not consume page-history shortcuts.
- History is local to the current edit session and does not survive reloads, identity, space or page changes. Successful save, cancel/restore or loading a server version clears it. It does not undo bookmark import, navigation maintenance, icon or source-record writes.
- **Save page** remains the explicit commit action. A failed or conflicting write retains the draft/history. If the write succeeds but the next read fails, the UI clearly reports that it was saved and retains the new revision and clean saved content for subsequent edits.

### Choose a theme and page appearance

Select the page at the top of **Layers**. **Homepage theme** offers two bundled choices:

| Theme | Default link appearance | What changes |
| --- | --- | --- |
| **Classic** | Icon + text | The classic navigation surfaces, spacing details and visual treatment |
| **iOS inspired** | App icons | Rounded icon containers, softer surfaces and an iOS-inspired visual treatment |

Switching the theme changes only its saved theme ID. Source bindings, component IDs, placement and locks, header/footer content, color mode, density and gap are retained. It does not reset the page or create another copy of the links. Both themes support the same built-in components and all six header/footer slots. They style the homepage; admin, setup and login retain the built-in management interface.

Under **Appearance**, set **Color mode**, **Content density** and **Component spacing**. These are page draft settings. To rename the page, use **Layout and theme → Page and appearance** in admin; the page name and the instance's site name are separate.

The admin's **Current theme** chooses the same two themes. **Grouped cards / Compact directory** are layout presets, a different operation: confirming one replaces the draft's components, bindings and placements, while retaining the current theme, custom header/footer content and the underlying local/external data. Preview before saving a replacement arrangement.

### Add and configure components

1. Choose **Add component**, then Search, Categories, Favorites, Bookmarks or GitHub Traffic. Traffic becomes available after a compatible GitHub Traffic source exists in the current space.
2. Select the component on the canvas or under **Layers**. Set its optional **Component title**.
3. Use **Position** to move it to a supported region, and **Up / Down** to reorder within that region. Category navigation supports top, left, right, bottom or hidden; it does not occupy the main grid.
4. Choose **Data source** when the component consumes data. Navigation, favorites and categories accept compatible navigation collections; Traffic requires its own schema. Search filters linked components and has no direct dataset selector.
5. For navigation and favorites, choose **Presentation → Cards / Directory**, then **Icons and text** as described below.
6. Configure **Search and category linking** if several components should filter together.
7. Use **Preview**, then **Save page** when the complete page is ready.

| Action or setting | Effect on the draft |
| --- | --- |
| **Duplicate component** | Copies the component's configuration and binding references to a new instance; it does not copy or create source records |
| **Hide / Show** | Keeps the component and its bindings available in Layers; showing a hidden component gives it a supported visible placement |
| **Remove component** | Removes that instance and its placement; source data and existing binding definitions are retained |
| **Lock position and size** | Prevents movement, resizing, hiding, duplication and removal until unlocked; content settings remain editable |
| **Width** | Changes an unlocked main-grid component's width in columns |
| **Height → Fit content** | Uses content height with a three-row minimum; avoids a fixed-height viewport where the surrounding layout permits |
| **Height → Fixed height** | Uses the selected height in rows and internal scrolling where content exceeds it |
| **Search width** | Keeps a region-based search component compact, up to 360 px |

A page accepts at most **32 components** and **32 source bindings**. Adding the same component type multiple times is supported. A shared binding or duplicated component does not grant additional data access. An unavailable source keeps its stored reference; it is not silently changed to another source.

The main region uses a **24-column grid**. On a wide canvas, drag an unlocked component's title handle to move it and the lower-right handle to resize it. Inspector controls provide an alternative to dragging. The layout keeps placements within bounds and avoids overlapping other configured grid footprints; a size change can reposition a component to make room. Locked components continue to constrain the available space.

At a canvas width of 900 px or less, components use the narrow arrangement and desktop dragging is disabled. This depends on the canvas's available width, including the space taken by the editor rails. Changing window size or opening a drawer does not write desktop coordinates. Existing fixed-height layouts remain unchanged until explicitly edited and saved.

Card columns use available width. Adjacent small categories can share a row while retaining their order, and larger categories use the full row. A final row can still have unused cells. **Cards / Directory** chooses the arrangement; the following setting independently chooses how each navigation or favorites component displays its icons:

| Icons and text | Behavior |
| --- | --- |
| **Theme default** | Follows the current theme; stored by omitting the `linkAppearance` key |
| **Icon + text** | Uses an icon beside the link text |
| **Minimal text** | Hides the decorative link icon while retaining the link text and actions |
| **App icons** | Uses rounded app-style icon containers with the link labels |

An explicit icon presentation remains selected after a theme switch. To let that component adopt each theme's default again, choose **Theme default**; in admin this option is labeled **Follow theme**. Changing presentation does not clear the icons saved on the links.

For exact X/Y, grid dimensions, region order or sticky behavior, the admin's **Layout and theme → Panels and data → Advanced settings** remains available. That editor expands one selected component at a time and uses the same page API and validation.

### Add document activity components

In **More editing options → Adjust layout → Add → Document activity**, choose **Document heatmap**, **Heatmap and records** or **Document calendar**. Add any preset repeatedly and arrange it with the existing grid controls; the admin layout editor offers the same presets and settings. Existing pages are preserved until you explicitly add and save components.

Each instance selects its own time range, directories, My edits/Library changes perspective, summary, recent records and time zone. Use an explicit **Date linking group** to share date selection; otherwise instances work independently, and a duplicate starts independent. Browsing dates/months and opened details is temporary. A day shows distinct documents changed that day and opens its records; available documents link to Library in their authorized space.

Activity requires a signed-in working-document reader. Public pages do not expose draft names, directories or counts. Initial scans establish a baseline instead of inventing edits from old file dates. See [the activity guide](DOCUMENT_ACTIVITY.md) for counting, permissions and configuration; no external activity source or credentials are needed.

### Adjust navigation and favorites content

On the homepage, choose **More editing options → Adjust layout**, select a **Bookmarks** or **Favorites** component on the canvas or under **Layers**, then open **Component content** in its properties. The admin provides the same controls under **Layout and theme → Panels and data → select the component → Component content**. These settings belong to that navigation or favorites instance; they do not change another component's content settings or its placement.

| Control | Choices and default | Effect |
| --- | --- | --- |
| **Maximum links per row** | **Automatic** (default), or **1–8 links** | Automatic uses the existing responsive layout. A number is an upper limit inside the component; narrow widths can show fewer links. It does not resize the component. |
| **URL display** | **When no description** (default), **Always**, **Hidden** | Shows the main URL's host when no description is displayed, always alongside any description, or never. Hiding the description also activates the default URL fallback. |
| **Description lines** | **1 line** (default), **2 lines**, **3 lines**, **Hidden** | Limits the displayed description to the chosen number of lines. Hidden corresponds to zero lines; the saved description is retained. |
| **Tags** | **Follow style** (default), **Show**, **Hide** | Follow style uses the existing theme, density and Cards/Directory behavior. Show explicitly displays up to the first three tags, including in a directory. |
| **Show additional URLs** | On by default | Shows the bookmark's internal/external network entrances and other additional URLs. Hiding them does not disable automatic route selection; manual recovery URLs can still appear if opening a new page fails. |
| **Show group titles** | On by default | Shows category-group headings or the favorites-group heading. Hiding headings retains the groups and their links; a separate custom navigation component title remains visible. |
| **Show link counts** | On by default | Shows link counts in visible component/group headings. A hidden group heading also hides its count. |
| **Content density** | **Follow page** (default), **Comfortable**, **Compact** | Inherits the page density or overrides spacing and sizing for this component's content. |

**Directory** stays a single column and does not show **Maximum links per row**. A previously chosen limit is retained and applies again when switching back to **Cards**. **Follow style** for tags is saved by omitting `showTags`; it is not a separate stored string or a `null` value. The URL label shows the host, including a non-default port when present; its tooltip retains the full URL.

Changes update the current draft and canvas/preview immediately, participate in **Undo/Redo**, and take effect for normal visits only after **Save page**. Cancel or Restore follows the same draft rules as other page settings. Existing pages that omit these options keep their compatible defaults; changing these controls does not modify bookmark records.

### Browse category bookmark folders

Navigation initially shows six bookmarks per category, including Uncategorized. When more remain, the folder entry shows **View all** and the remaining count. Open it for the full currently matched category, with up to four responsive columns, name/URL/description/tag search and 24 bookmarks per page. Current homepage filters still apply and are identified in the dialog. Favorites retain their own complete display.

Use **Category preview** in the navigation component's content settings to choose **All**, 4, 6, 8, 12 or 24. The homepage inspector and **Layout and theme** provide the same control. Save the page to change the shared default. This limits only the homepage preview; navigation datasets, administration and exports retain every authorized bookmark. Opening, searching and paging a folder are temporary.

The dialog focuses search when opened. Close it or press Escape to return focus to its folder entry; a changed category scope closes the old folder. Preview folders stay inside their own preview surface.

### Link search and category filters

Use **Search and category linking** in the selected component:

| Choice | Effect |
| --- | --- |
| **Main navigation** | The preset group. Search, category and link components in this group filter together. |
| A named group | Components with that same group share search/category state independently from other groups. |
| **Use independently** | Only this component uses its filtering state; **Independent from other panels** in admin. |
| **Existing group 1**, and so on | A previously saved custom identifier without a friendly-name prefix; its full value is retained. The admin inspector also exposes the identifier in a tooltip. |

In the visual editor, select **New linking group**, enter a name such as `Work`, `Personal` or a Chinese name, then select **Create**. The admin labels these actions **New group** and **Create and select**. Names support up to 75 characters. Select the same group for the associated search, category and navigation components, then save the page. Creating a group with an existing name selects the same group.

A group controls filtering relationships, not permission or data copying. No internal English identifier needs to be typed. An independent search has no other component to filter; give it and its target navigation component the same named group. Homepage search includes titles, descriptions, tags, main URLs and additional entrance labels/URLs. A parent category includes its descendants' links.

### Maintain header and footer content visually

1. In homepage edit mode, select the **Header** or **Footer** under Layers, or click its Left, Center or Right slot directly on the canvas. Empty and disabled areas remain selectable while editing.
2. Set **Show header / Show footer** as needed. The inspector's alignment buttons select which slot you are editing.
3. Select **Text**, **Link** or **Branding** to add an item. Adding an item enables that area. Fill in the text and, for a link, **Link URL** and **Open in a new tab**.
4. Select an existing item to edit it. Use its up/down actions to reorder within the slot, or **Remove item** to remove it from the draft.
5. Use **Area** and **Alignment** to move the selected item between any of the six slots. If its new area is disabled, enable that area to show the moved content.
6. Preview the whole page and use the same top-level **Save page** as for components and themes.

| Content / rule | Limit and behavior |
| --- | --- |
| Text | Required plain text, up to 500 characters; line breaks allowed |
| Link | Required text up to 160 characters and a complete HTTP/HTTPS URL up to 2,048 characters; no credentials, whitespace, control characters or backslashes in the URL |
| Branding | Jade folded-house project mark, name and version; may be moved or removed |
| Capacity | Up to 8 items per alignment slot; the complete page configuration must remain within 64 KiB |
| Disabled area | Items are retained and still validated when saving |
| Type changes | Inapplicable link/text fields are removed; retained overlong text must be shortened before saving |

Saving validates **all six slots**, including another selected alignment and disabled areas. If an item is invalid, the editor exits preview if necessary, selects its area/slot/item, opens its inspector and focuses the invalid field. No page update is sent until validation succeeds. Header/footer changes have no separate save action.

All content fields render plain text; they do not execute HTML, Markdown, scripts, arbitrary widgets or custom CSS. IDs are generated automatically. The technical [page chrome contract](API.md#header-and-footer-content) also applies to external writers. The admin's **Layout and theme → Header and footer** remains an alternative editor for the same data.

An older page without `chrome` displays an empty disabled header and an enabled footer with branding in the right slot. In normal browsing, the configurable header is an additional content row below the site header. During editing the site header is replaced by the dedicated toolbar; in preview the normal header presentation returns. The footer is at the bottom of a short page and after the content of a long page. It does not overlay links. Themes and layout presets retain custom header/footer content.

### Preview without saving

In the homepage editor, select **Preview**. The rails and selection outlines disappear, and the draft uses the ordinary homepage header presentation. **Keep editing** returns to the same draft and selection. The editing toolbar remains available so you can save, cancel or return without leaving the page.

The admin offers a separate size-controlled preview:

1. Open **Layout and theme → Preview homepage**.
2. Choose **Preview resolution**: **2560 × 1440**, **1920 × 1080**, **1600 × 900** or **2560 × 1080**. A scaled iframe uses that full logical viewport, not the dimensions of the small preview container.
3. Change settings and inspect the draft. Use **Enlarge preview** for a larger surface; **Return to editing** or Escape closes the enlarged view, and **Close preview** hides the side preview.
4. **Save page** in the enlarged preview submits through the same page validation and revision check. Opening or enlarging it does not save automatically.

Both previews use authorized source data. Matching projections are reused; a newly selected visible source may require a read of its existing snapshot. Previewing does not request an upstream synchronization. Unavailable snapshots or filtered projections remain unavailable, with a notice and Retry where a read failed.

Search and category disclosure in preview use isolated in-memory state. They do not update the page, normal browsing preferences or links. Favorite writes, account/space changes and navigation to external links are unavailable during homepage editing and preview. Leaving or reloading the editor can discard unsaved drafts. The [older admin preview capture](https://github.com/zhigege666/Lingshu-Home/blob/v0.0.1/assets/screenshots/admin-brand-preview-2k.png) is historical and does not show the new homepage editor or iOS theme.

### Save, restore or cancel

- **Save page** validates and sends one revision-checked replacement of the complete page draft, including theme, components, layout and header/footer content. It is enabled when the draft has changed. Ctrl/Cmd+S uses the same action in the visual editor.
- **Restore** returns to the configuration captured at the start of this edit and keeps the editor open. It does not fetch a newer server version or apply a factory preset.
- **Cancel** discards the homepage draft, exits editing and reads the current saved page. In admin, **Cancel changes** restores the currently loaded saved page.

In the editable canvas, folding a whole category component updates its draft default; tree branches and search remain temporary. When a changed category default/style is saved, conflicting whole-panel preferences for those components are cleared in the current tab. Other components and visitors' tabs are not rewritten.

If saving succeeds but the following reload fails, the UI reports that distinction and retains the saved configuration and its new revision. Do not assume the write failed and repeat it blindly.

### Resolve a page-save conflict

If another window or client saved first, Home returns HTTP **409 `page_version_conflict`** and keeps your draft. It does not silently overwrite the newer version.

In admin, use **Download current draft** for a reference copy. **Inspect server version** reads the newer page; **Load server version and replace current draft** is the explicit replacement step. Reapply the intended differences and save. This version does not offer a draft-file import button.

Homepage editing also preserves a conflicting draft. Record the intended changes, then Cancel to load the current saved layout and repeat them. Restore returns only to the start of the local edit, so it does not resolve a stale revision by itself. An in-memory draft is not a durable backup.

### Know which controls save data

| Action | Persistence |
| --- | --- |
| Ordinary homepage search, category selection, card/directory and color buttons | Temporary viewing state; no page write or upstream synchronization |
| Ordinary category panel/branch folding | Browser-tab preference, scoped to page and component |
| Component/theme/chrome changes, **Fit content** or whole-category folding in the editable canvas | In-memory page draft until **Save page** |
| Opening/closing homepage preview; changing resolution/enlarging admin preview; preview search/folding | Read-only preview and isolated temporary state |
| **Save page** in either editor | Saved complete page configuration, checked against its revision |
| **Cancel changes**, **Cancel**, **Restore** | Change local editing state as described above; no page write |
| Star a local link in ordinary browsing | Immediate saved navigation change, requiring edit permission |
| Choose an icon in a link/category form | Form draft until that link/category is saved |
| Import/delete an icon library or fetch a website icon | Immediate space-scoped library/cache write; canceling the link/category form does not roll it back |

To make an appearance choice the default for visitors, change it in an editor and save the page. Refreshing starts from saved appearance; ordinary browsing does not clear the tab's category-folding preference.

## 6. Configure category navigation

In homepage edit mode, select a Categories component on the canvas or under Layers and open its **Category style** settings. You can add additional category components through **Add component**. The admin alternative is **Layout and theme → Panels and data → Category navigation appearance**. Each component can choose its own data source, linking group and top/left/right/bottom/hidden placement.

| Control | Choices and effect |
| --- | --- |
| Display mode | **Icon + text**, **Icons only**, or **Text only** |
| Category hierarchy | **Tree hierarchy** preserves expandable parent/child presentation; **Flat categories** lists every category with its full path |
| Show link counts | Shows or hides category counts |
| Allow expanding and collapsing | Allows the entire text-based category panel to collapse to an icon strip; **Allow collapsing to icons** in admin |
| Collapsed by default | Starting state without a manual tab-session preference; **Collapsed to icons by default** in admin |

Defaults are icon + text, tree hierarchy, counts on, collapse allowed and initially expanded. Existing pages without these fields use the same defaults. Pure-icon mode is already compact, so whole-panel folding controls do not apply; tree branch controls remain available.

The main collapse button changes the whole strip or side panel. Each tree node's arrow expands/collapses its children separately, without selecting that category. Clicking the category itself filters links, including descendants. The ancestor path of a selected child stays open; choose another category or all links before collapsing that path.

Icon buttons retain full labels through accessible names and hover/keyboard-focus tooltips. Escape dismisses a tooltip. Top, bottom and narrow-screen categories stay on a horizontal line; scroll the strip or use its overflow arrows. Left/right icon-only category regions can shrink to 72 px. If another component shares that side region, its space is preserved.

In ordinary browsing, manual panel and branch states survive refresh within the tab and are isolated by page and component. An existing manual choice takes precedence over the saved collapsed default; check that default in a session without a prior choice. These preferences do not change server data or another user's configuration. In the editable canvas, whole-panel folding changes the unsaved default; both preview paths use separate in-memory state.

Homepage parent counts include descendant links in the bound dataset. The category management table counts links directly assigned to each category, so the two views can legitimately show different numbers.

## 7. Connect external sources, GitHub Traffic and MCP

Use a signed-in account with edit rights to the destination space. The step-by-step UI tasks below lead into the exact formats in [INTEGRATIONS.md](INTEGRATIONS.md).

### What Component data format means

**Sources and MCP → Sources → Add source → Component data format** selects the data contract that the source will supply. It does not create a new kind of component or register a custom format. The generic source editor has five built-in choices:

| Format | Schema ID | Compatible presentation |
| --- | --- | --- |
| Bookmarks | `navigation.collection@1` | Navigation, categories and favorites |
| Calendar | `calendar.events@1` | Calendar/agenda |
| Weather | `weather.forecast@1` | Weather |
| Metrics | `metrics.summary@1` | Metric cards |
| Service status | `status.collection@1` | Service status |

The periodic JSON source supports the four component formats, not Bookmarks. GitHub Traffic uses its dedicated source type and `github.traffic@1`, rather than adding another choice to this generic selector. Creating multiple sources with the same format is supported; the format of an existing source cannot be changed.

The source form explains this boundary and lets you expand a JSON data example for the selected format. For a push source, create it, open **Push template**, replace the example data in the external sender, send a snapshot, then bind a compatible homepage component and save the page. For periodic JSON, the configured endpoint must return the selected format's `data` object. Adding an entirely new schema requires application development: a server validator, compatible renderer and exposed capability must be implemented together. Importing a component template does not install a new format. See [component contracts](COMPONENTS.md) and [source configuration](INTEGRATIONS.md#source-configuration).

### External navigation pushes

1. Open **Sources and MCP → Sources → Add source**.
2. Select **External push / Calendar file import**, choose **Bookmarks** as the component data format, give it a name and create it.
3. In **MCP and access tokens**, create a token scoped to that source. The UI grants source read and snapshot push for this scope. Copy the secret when it is shown; it cannot be shown again later.
4. Return to the source and open **Push template**. Use its endpoint and replace the sample payload and token in your external client.
5. Send a complete snapshot with a unique request ID and its revision/sequence guard. An identical retry reuses that request ID; changed content needs a new request ID.
6. After a successful push, inspect **Snapshot**, then bind a navigation component to this source in the layout editor and save the page.

A push replaces that external source's snapshot. It does not merge records into **Link management** or overwrite local bookmarks. Empty collections are meaningful replacement data. The protocol supports 10,000 links, 5,000 categories and at most 8 MiB of canonical snapshot JSON; see [push validation and retries](INTEGRATIONS.md#push-protocol).

### GitHub repository Traffic

1. Add a **GitHub Traffic · Repository traffic** source with repository owner, repository name and a GitHub token authorized for that repository's Traffic API.
2. Create it, then use **Collect baseline** if you want to queue a capture immediately. Creation also enables the scheduled source. The default schedule is every six hours.
3. Wait for **Snapshot available** and inspect **Last success**. “Collecting” means work is queued/in progress, not that GitHub data has been received.
4. Add a GitHub Traffic component in **Layout and theme**, select the source and save.
5. Use **Collect again** to queue another collection when needed. For credential rotation, open **Configure** and enter a replacement; leaving it blank retains an existing credential.

The first successful views-and-clones capture becomes the immutable baseline. Later polling preserves observed UTC daily history. Rolling-window comparisons are not lifetime totals; missing observations remain missing. Failed collection keeps the previous successful snapshot. SSH access to a Git repository is not a GitHub API token. Permission requirements and the exact metrics are documented in [GitHub Traffic](INTEGRATIONS.md#github-traffic).

A source cannot be retargeted to a different repository after its first snapshot. Create a separate source for that repository. Source configuration can disable a source while retaining data; source deletion is not exposed in this version. No real repository credentials or baseline are bundled by default.

### Home tokens and MCP clients

Open **MCP and access tokens → Create token**. Name the client, choose current-space or source-specific scope, select the necessary actions and choose the UI's 7-, 30- or 90-day lifetime. A source-specific token is suitable for one external publisher; use current-space scope for local bookmark or page management.

Configure an MCP client that supports **Streamable HTTP** with the displayed `/mcp` address and `Authorization: Bearer <Home token>`. This token is issued by Home and is separate from a GitHub source token. The client must support sending the header; an OAuth-only setup is not provided by Home. Discover the tool schemas through the client, then use actions allowed by that token.

The token can be viewed only at creation. Revoke it from the token list to stop a client. Changing access mode invalidates existing sessions and tokens; password resets or disabling a Member invalidate that Member's access. Tokens cannot create accounts, change global security settings or issue more tokens. Detailed scopes, protocol negotiation and examples are in [MCP transport](INTEGRATIONS.md#mcp-transport).

## 8. Manage members and access

As Owner, open **Site settings** to change the site name and mode. In **Multiple users**, optionally enable **Allow visitors to register member accounts**. Save and sign in again when the change invalidates your current session. Switching modes preserves personal-space data and does not publish it.

In multi-user mode, open **Member management → Create member** to set a username, display name and initial password. The member can then sign in to their own space. Use **Edit** to change the display name, disable/enable the account, or set a replacement password. Leave the reset-password field empty to retain the password. Disabling or resetting invalidates that account's existing access. The interface does not expose Member deletion or an email password-recovery flow.

An Owner can maintain the shared space and their own personal space; they cannot inspect Member personal pages. A Member may see shared navigation but cannot maintain it. If edit actions are unavailable, first check both the selected space and the active access mode.

## 9. Export, back up and restart

### Export the current space

Use **Import and export → Export HTML** for a browser-compatible bookmark file, or **Export JSON** for local links, categories, the space and its page configuration. JSON does not include accounts, source credentials, external snapshots or the binary images and metadata of imported icon libraries. Neither export is a full-instance backup; JSON is not a one-click restore or SQLite-to-PostgreSQL conversion format. Custom icon references require their original database assets to render.

### Preserve the database and keys

For a complete backup, follow [STORAGE.md](STORAGE.md#backups). For SQLite, the straightforward procedure is to stop Home cleanly and back up the complete persistent directory/volume, including both keys, any private `storage.json`, document recovery history and any WAL files. For PostgreSQL, back up the dedicated database, matching local keys and saved storage configuration together. Back up externally mounted document originals/attachments separately, with their deployment mappings. Restore with the appropriate application version before starting one instance.

Custom icon images, library metadata, website caches, the automatic switch and pending jobs are included in the database, with no extra upload directory to copy. Version 0.0.1 includes automatic-icon **migration 005** and network-setting **migration 006**. Version 0.0.2 adds **migration 007** for the fixed instance language; a database backup retains that choice too. Version 0.0.5 introduced the document library in **008**; 0.0.6 adds document activity in **009** and session retention in **010**, applied on first start. Preserve the same database, keys, allowed document roots and existing mounts. An older binary that does not recognize an applied migration refuses that database. Rolling back requires the matching pre-upgrade database and keys as well as the older binary/image.

The README image command uses the **`lingshu-home-data`** named volume; source Compose uses its project-scoped **`home-data`** volume. Retain the original volume and Compose project identity when restarting or replacing a container. Switching installation methods does not transfer data automatically. For a Linux release, reuse the original `--data-dir` instead of a new empty `data/` beneath the next version directory. Removing a volume discards persistent data; do not use volume-removal commands as a restart procedure. Keep exports, full backups and credential files private.

### Restart and check the service

For the published image command in the README:

```bash
docker restart lingshu-home
docker ps
docker logs --tail=100 lingshu-home
curl -fsS http://127.0.0.1:5180/health
```

Use `docker stop lingshu-home` and `docker start lingshu-home` around a backup, retaining `lingshu-home-data`. The image example sets a 30-second stop timeout.

For source Compose:

```bash
docker compose restart home
docker compose ps
docker compose logs --tail=100 home
curl -fsS http://127.0.0.1:5180/health
```

For PostgreSQL Compose, use `docker compose -f compose.postgres.yaml` consistently with the same private environment configuration. To stop and start for a backup, use `docker compose stop home` and `docker compose start home`; stop alone does not remove the volume.

For a foreground Linux release, press `Ctrl+C` and wait for exit, then run from the release directory with the original language and stable data path, for example:

```bash
./lingshu-home --language en --data-dir "$HOME/.local/share/lingshu-home"
```

A deployment started with the Linux development helper uses:

```bash
python3 scripts/dev.py stop
python3 scripts/dev.py start --language en
python3 scripts/dev.py status
```

Keep the original provider and data-directory options when restarting. These examples keep an explicit English language value, which is needed to preserve English on the first upgrade from 0.0.1; after 0.0.2 saves the language, the database remains authoritative even if that option is omitted. A restart does not build new source. For a source update, retain a recoverable backup and the prior version, build using the README, and restart using the same data directory/provider. See [storage migration rules](STORAGE.md#versioned-migrations) before downgrading.

The Linux development helper permits an immediate restart while closed connections finish their TCP timeout. A port still used by a running listener remains an error; check `status` and the selected listen address before starting another instance.

## 10. Troubleshooting

| Symptom | What to check |
| --- | --- |
| Cannot open Home from another device | The default host port is loopback-only. Check the deployment address, published interface and proxy; `127.0.0.1` on another device refers to that device. |
| Storage setup reports an error | Repair the selected database connection and use Retry. Check `/health`; do not erase `storage.json` or point at an empty database to bypass recovery. |
| A previously used instance asks for setup | Check the selected database/provider and data volume. Stop and verify the intended persistent storage before initializing what may be an empty replacement location. |
| Admin content appears missing | Check **Current space**, search text, page number and category filter. Local link management reads the local dataset even if homepage bindings have changed. |
| Link exists in admin but not on the homepage | Check whether a navigation component is present/visible, its source binding, category/search/favorites filters, and fixed-height panel scrolling. |
| List edits cannot save after a conflict or network failure | Keep the draft and use Read latest and compare. Resolve fields before saving; do not repeatedly submit an uncertain batch. |
| A category shows only six links | Open its View all folder, or save another Category preview value in that navigation component. No bookmarks were removed. |
| Document activity shows a login/permission placeholder | Sign in with working-document access to the selected space. Published-document access alone does not expose activity. |
| Cannot save a page | Read the inline error. Check revision conflicts, overlapping/out-of-range grid coordinates and locked components; the draft is retained after a rejected save. |
| Language did not change | In 0.0.2 this is expected once the language is saved; a conflicting startup value is ignored with a warning. It is not a setting you can switch later. Stored names remain unchanged. |
| Preview differs from the saved homepage | Check the Unsaved draft marker and any temporary filters. Preview follows the current editor draft; other visitors see saved configuration. |
| Changing theme does not change a component's icons | That navigation/favorites component may have an explicit **Icons and text** choice. Choose **Theme default** to follow each theme, then save the page. |
| Cannot add, duplicate or move a component | Check its lock, the 32-component/binding limits and available placement. GitHub Traffic needs a compatible source first; Categories cannot occupy the main grid. |
| Preview shows incomplete source data | Check the binding and source snapshot. Missing filtered projections are not fabricated; Retry can repeat failed authorized reads. |
| Footer content is absent | Check Footer → Show footer content, the selected alignment and unsaved state. A long page places its footer after the full content. |
| A hidden header/footer item prevents saving | Disabled regions retain and validate their items. Follow the error to fill or remove the invalid item, then save again. |
| Cannot delete a category | Move its direct links and child categories first. |
| Cannot delete an icon library | Replace saved references to images owned only by that library; links, categories, page configuration and external snapshots are checked. |
| Website icon is unavailable | Check the instance switch and link mode, then refresh the list after background work finishes. Lookup supports reachable public/LAN HTTP/HTTPS hosts and custom ports since 0.0.4; check server DNS/reachability, HTTPS trust and supported image formats. Failures have a 30-minute cache; for login-only sites or complex artwork, import a PNG or use a bundled icon. |
| Canceling a link form did not remove its imported icons | Library imports/deletions and website caching save immediately; cancel only discards the form's selected icon. |
| Bookmark import shows only 200 rows | This is the preview display limit. Its totals still cover the full file. |
| Import rejects a URL or file | Use browser-exported UTF-8 HTML within 2 MiB / 10,000 links; only HTTP/HTTPS links are accepted. Check the combined destination folder depth. |
| “Default collapsed” does not change the current tab | Manual tab-session choices take priority. Toggle the panel yourself or inspect the default in a new session without that preference. |
| Source has no data | Open its configuration/status and snapshot. A push source needs its first successful push; Traffic needs authorized GitHub collection and compatible component binding. |
| Token/client stopped working | Check expiry, revocation, account status, mode changes and token scope. Create a replacement from a signed-in account when appropriate. |
| Copy button fails | Select and copy the displayed value manually; clipboard access depends on the browser's origin/security rules. |
| Login repeatedly fails or shows a request limit | Check credentials and the active mode. Wait for the indicated retry interval after rate limiting; do not bypass it with an alternate route. |
| Service reports storage unavailable or cannot start | Check logs, data ownership, database connectivity and singleton locks. PostgreSQL lease loss requires a controlled restart after connectivity is restored; do not start competing instances against the same database. |

For performance with many entries, use categories/search to narrow the homepage, try directory/compact presentation, and choose a smaller admin page size. These controls change presentation workload; they do not turn the API into server pagination or provide a measured latency guarantee. Capture the dataset size, browser, viewport and operation when reporting a performance issue.

## 11. Current boundaries and further references

The delivered model is a standalone navigation application with embedded/external storage, a built-in admin, visual page composition, two bundled themes, local icon libraries and optional integrations. Arbitrary third-party theme packages, general real-time adapters, knowledge-base connectors, multiple homepage management, automatic provider migration, a full backup GUI, native Windows/macOS clients and desktop auto-update are not implemented features.

Use [API.md](API.md) for field contracts and limits, [INTEGRATIONS.md](INTEGRATIONS.md) for external writers, [ICONS.md](ICONS.md) for custom images and website caching, [STORAGE.md](STORAGE.md) for persistence, and [RELEASING.md](RELEASING.md) for packaging. Runtime screenshots and their historical/current scope are linked from the [README](../README.md#screenshots). Public runtime screenshots and user documentation may be shared; internal design files, private configuration and user data must stay out of Git, frontend assets and release packages.

## File-backed document library

Open **Library** beside Home to read authorized bookmarks and Markdown documents. The Owner connects existing directories through **Admin → Document directories** using the deployment's allowed roots; connections start read-only. Editing originals, publication, recovery history, attachments, bookmark usage notes and API/MCP access follow the [document-library guide](DOCUMENT_LIBRARY.md). Document activity is configured separately as a repeatable homepage component.

## Calendar, weather and other data components

Open **Admin → Integrations** and add a data source before binding a calendar, weather, metrics or service-status component. An ICS subscription keeps following its secret HTTP/HTTPS URL. A one-time ICS file import uses a calendar push source and replaces its current finite-window snapshot. Choose a personal space for a private calendar; shared-space event content follows that space's viewing permissions. Source URLs/credentials stay on the server.

For weather, choose a city shortcut or enter coordinates and an IANA timezone, then select the free non-commercial provider or the commercial provider with its API key as appropriate. Saving an enabled polling source queues collection; **Sync** queues another attempt. Its success/error status reports the actual result. The homepage's **Refresh data** reads stored data and does not force an upstream request. Disabling a source stops collection while preserving its last successful snapshot. Hiding a component only changes the page.

In **More editing options → Adjust layout → Add**, add the compatible component, or choose **Import template** and paste an HTTP/HTTPS component URL / JSON (reachable LAN hosts and custom ports are supported since 0.0.4). Review its renderer, version, license and source before selecting a local data source. Apply it to the draft, arrange it and use **Save page**. Cancel/restore/leave prompts preserve an unsaved draft until you explicitly discard it. A normal webpage without a supported manifest cannot be imported as executable code.

The complete data schemas, provider limits, replay/storage policy, supported template format and currently deferred connectors are in [COMPONENTS.md](COMPONENTS.md). Setup previews the website pack matching the saved instance language; leaving examples off starts with no bookmarks.


## Network settings and internal/external access

Open **Network settings** in Admin. Automatic selection is enabled by default, and its save changes only that preference. In the link editor, explicitly configure Internal and External network routes. Keep documentation/admin links in Additional URLs for manual access. An empty probe path uses `/favicon.ico`; a read-only, unauthenticated `/healthz` is also suitable. A click waits at most about 800 ms before choosing an internal response or falling back to the external/primary URL. Manual routes are always available.

Loading, hovering and leaving Home idle do not probe the network. A cross-origin probe path must allow Home to read its response. If the site's favicon does not permit this, configure a public read-only health path on that service/reverse proxy or use its manual route. Browser permissions or network policies can also block detection; no response does not prove a service is offline. Observations exist only in short-lived browser memory and are invalidated by connectivity changes or refresh.

An Owner can configure a server HTTP, HTTPS or SOCKS5 proxy with separate credentials on the same page. It applies to Home icon/template/source fetches, and addresses are interpreted from the Home server/container. Credentials are encrypted and never returned. Changing the proxy endpoint requires replacement credentials or an explicit clear. Saving does not test connectivity; the proxy must support CONNECT to the target port, including port 80 for HTTP. See [the complete protocol and recovery rules](NETWORK.md).

## Choose a component template from a web page

Select **Import a component template** in the homepage editor and enter a page or JSON URL. A page must advertise compatible Home templates in its head; select one when multiple declarations are found. Review the renderer, version, license, data format and source. Errors preserve the input, and loading can be stopped before retrying.

**Template examples and page declaration** provides built-in component examples to insert or download as JSON. Choose a compatible source before adding an external-data component to the page draft. Document activity automatically uses its built-in local binding. Signed-in editors can create a compatible source within the same workflow and return to the preserved preview. Source creation saves immediately; the component still requires Add to page draft and the normal page Save. Template source URLs are public provenance shared/exported with the page; put private subscription addresses in separate encrypted source configuration.

## Start with a dashboard preset

Open **More editing options → Adjust layout → Add → Dashboard presets**. **Personal overview** combines weather, an agenda and bookmarks. **Service operations** combines service status, resource metrics and operational links. **Data summary** combines two metric groups with optional GitHub Traffic and reference links. The layout preview uses component labels, without adding sample values or starting collection.

For each selected component, choose an enabled source with its matching data format. A component marked **Needs a source** must be bound or deselected before applying. A source without a first snapshot is allowed and displays the usual waiting-for-data state. Bookmarks and favorites retain their existing compatible source, filters and interaction group; a new or changed source starts without the old source's filters. Selecting the same source for both metrics groups displays the complete group twice, and the dialog explains this.

**Replace draft layout** changes only the unsaved page arrangement. Existing theme, appearance, header/footer and search/category settings remain. Use **Save page** to persist, or the editor's Cancel/Restore controls to discard the draft. Creating a source inside the dialog saves that source immediately and is a separate operation. Hiding, omitting or removing a component does not disable an existing polling source; disable the source itself to stop its collection.

The [dashboard guide](DASHBOARDS.md) describes each slot. The [data handoff examples](../examples/dashboard-data/README.md) provide eight validated push bodies and a contract index for future adapters. Their fixed example dates and unknown values are for development and are never automatically installed as current observations.
