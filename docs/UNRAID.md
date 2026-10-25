# Unraid installation

**English** | [简体中文](UNRAID.zh-CN.md)

Lingshu-Home provides a Docker template for Unraid's Docker Manager and Community Applications. The template selects the **Linux amd64 (x86-64)** image `ghcr.io/zhigege666/lingshu-home:latest`, following published stable releases with embedded SQLite. No external database is required. Exact version tags such as `0.0.5` remain available.

These instructions target **0.0.5**, which adds a file-backed Markdown library, bookmark usage notes and optional direct HTTPS. Existing HTTP installations can retain their configuration: document access defaults to disabled and both direct-TLS fields default to empty. Version 0.0.5 applies migration **008**, so back up before upgrading. The language is chosen once and saved in the database; an existing 0.0.1 instance must also follow the language and migration-007 requirements below.

## Install

When Lingshu-Home is available in **Apps**, search for **Lingshu-Home**, check that the repository is **zhigege666/Lingshu-Home**, and choose Install. Review the settings below before applying them. If it is not yet listed, use the manual template installation.

### Manual template installation

Download [the current raw template](https://raw.githubusercontent.com/zhigege666/Lingshu-Home/main/templates/lingshu-home.xml) and save it on your Unraid boot device as:

`/boot/config/plugins/dockerMan/templates-user/my-lingshu-home.xml`

Create the `templates-user` directory if needed. If that file already exists, back it up and compare your saved settings before replacing it. Do not overwrite another Home installation's template.

Open **Docker → Add Container**, select **Lingshu-Home** from the template list, review the configuration, and choose **Apply**. Docker Manager pulls the image and starts the container. This installs the application locally; it does not mean that Community Applications has approved the repository.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Repository | `ghcr.io/zhigege666/lingshu-home:latest` | Highest published stable version; updates still require pulling and recreating the container. |
| Network | `bridge` | Publishes Home through a host port. |
| WebUI port | Host `5180` → container `8080/tcp` | Change the host port if it is already used; keep the container port at `8080`. |
| Appdata | `/mnt/user/appdata/lingshu-home` → `/data` | Database, saved icons, document metadata, recovery history and instance keys. Retain this mapping during container replacement. |
| Interface language | `en` | Choose `en` or `zh-CN` before the first start or first upgrade from 0.0.1. A saved instance language takes precedence on later starts. |
| Allowed document roots | `[]` | Advanced, optional `LINGSHU_DOCUMENT_ROOTS` JSON array of container paths. The empty array disables access to document files. Add the corresponding Path mappings separately. |
| TLS certificate file / TLS private key file | Both empty | Advanced, optional container paths to a matching PEM certificate chain and key. Set both to enable direct HTTPS, or leave both empty for HTTP and HTTPS terminated by a reverse proxy. |
| HTTPS-only cookies | `false` | Advanced setting. Use `true` for an HTTPS reverse proxy; direct TLS automatically uses Secure cookies. This field alone does not enable HTTPS. |

Use a dedicated appdata directory for each Home instance. To use a different share or pool path, change the **host** side of the Appdata mapping and retain `/data` as the container path. Do not use the same data directory for two running containers.

### Data ownership

The published image normally runs as `10001:10001`. The Unraid template explicitly supplies `--user=99:100` to use Unraid's appdata owner and group. The application does not implement `PUID` or `PGID`; adding those variables does not change its identity.

The selected appdata directory must be writable by UID `99` and GID `100`. Docker Manager creates missing mapped host directories with that owner and group; it does not repair an existing directory's ownership. For a new dedicated directory, owner write/execute permission is sufficient; world write access is not required. Files such as the database and instance keys are private to the running user.

If you are moving data from the image's default identity or another deployment, stop Home, make a complete backup, and adjust ownership only within the dedicated Home data directory. Do not recursively change the entire appdata share. Keep the same chosen identity for later starts. See [storage and migration](STORAGE.md) before changing an existing deployment.

The template sets Docker's default stop timeout to 30 seconds, drops Linux capabilities, and enables `no-new-privileges`. Privileged mode is disabled. Unraid's WebUI and array shutdown can override the container timeout with the global Docker stop timeout; configure that global setting to allow at least 30 seconds as well. The template leaves Docker's restart policy unset; configure **Autostart** in the Unraid Docker tab if you want Home to start with the array.

## First start

Open the container's **WebUI** action or visit `http://<Unraid-IP>:5180` using the host port you selected. Unlike the README's loopback-only Docker example, this bridge port mapping makes the service reachable through the Unraid host's network interfaces.

Complete the setup wizard on your trusted network. Choose a site name and access mode, then create an Owner when that mode requires one. There is no default administrator account or password. The default public-browsing mode requires an Owner for changes and keeps personal spaces private. Open editing can be account-free.

For a new Simplified Chinese instance, set **Interface language** to `zh-CN` before the first start. The template defaults to `en`, so its explicit language skips the browser's language-selection page. After the language is saved, changing this field cannot switch it.

### One-time language and upgrading from 0.0.1

A new instance with an explicit container language saves it once and skips language selection. Without a configured language, its first page asks for English or Simplified Chinese before setup. The interface and optional starter collection use that same language; there is no independent example-language dropdown or later in-page switch.

An initialized 0.0.1 instance saves the language supplied on its first upgraded start, or the old `zh-CN` default if none is supplied. Keep **Interface language** set to the original value during the first 0.0.2 start, especially `en` for an English instance. Once saved in the database, the language survives container replacement with the same Appdata. A conflicting startup value is ignored with a warning while the service keeps running; editing the Unraid field later is not a supported language-change mechanism.

Version 0.0.2 applies migration **007** to SQLite or PostgreSQL. Before upgrading, stop Home and back up its database and matching keys. Rolling back to 0.0.1 needs that pre-upgrade backup, not just the old image. See [storage and recovery](STORAGE.md).

## Connect existing Markdown directories

The template deliberately supplies no example document Path mappings. Add only the directories you intend to expose; Unraid can create a missing host path automatically, so check the spelling, existing files and any NAS mount before applying the configuration. Keep the normal `/data` mapping separate.

1. Open **Docker → Lingshu-Home → Edit**. Enable **Advanced View** to find the optional variables.
2. Use **Add another Path, Port, Variable, Label or Device**, choose **Path**, and add one mapping per existing directory. For example:

   | Name | Host path | Container path | Access mode |
   | --- | --- | --- | --- |
   | Notes | `/mnt/user/knowledge/notes` | `/documents/notes` | Read Only initially; Read/Write if original-file editing is intended |
   | Project documents | `/mnt/user/projects/docs` | `/documents/projects` | Read Only |

3. Set **Allowed document roots** (`LINGSHU_DOCUMENT_ROOTS`) to `["/documents/notes","/documents/projects"]`. Enter the JSON array without extra shell quotes. If the field is missing from an older saved template, add a **Variable** with that exact key and value.
4. Apply the edited configuration so Docker Manager recreates the container with the mappings. A plain container restart does not add a new bind mount.
5. Sign in to Home as Owner, open **Admin → Document directories**, and connect each **container path** to your personal or shared space. One space can manage multiple directories; each directory has one managing space in this version. Sources are read-only by default. Select an enabled writable source as the default new-document location if needed.

Original-file editing requires both a writable Docker mount and **Allow writing original files** in Home, plus filesystem permission for UID `99` / GID `100`. A writable mount alone does not grant users or agents file-write permission. Start with read-only access when connecting an existing library. Do not allowlist `/`, `/data`, certificate directories or an entire appdata tree. Connecting a shared directory does not automatically publish its documents.

The original Markdown and attachments stay in these directories; metadata and recovery history also require the normal `/data` backup. External editors can continue using the files. See [document library behavior, limits and recovery](DOCUMENT_LIBRARY.md).

## HTTPS

Existing HTTP installations keep **TLS certificate file** and **TLS private key file** empty, and **HTTPS-only cookies** set to `false`. If TLS terminates at an existing reverse proxy, leave both direct-TLS fields empty and set **HTTPS-only cookies** to `true` when accessing Home through that proxy's HTTPS URL. Configure its upstream and network exposure as described in the [transport guide](TRANSPORT_SECURITY.md).

To serve HTTPS directly from Home:

1. Prepare a certificate chain and matching private key whose hostname/IP matches the address clients use. Their issuing CA must be trusted by those clients. Keep certificates separate from document roots.
2. In **Docker → Lingshu-Home → Edit**, add a **Read Only** Path from your existing certificate directory, for example `/mnt/user/appdata/lingshu-home-tls`, to `/certs`. Ensure UID `99` / GID `100` can read the files; do not grant world read access to the private key.
3. Set **TLS certificate file** (`LINGSHU_TLS_CERT_FILE`) to `/certs/fullchain.pem` and **TLS private key file** (`LINGSHU_TLS_KEY_FILE`) to `/certs/privkey.pem`. These fields contain paths, not PEM contents. Add the two Variables manually if an older saved template does not show them.
4. In Advanced View, change **WebUI** to `https://<certificate-covered-hostname>:[PORT:8080]`, replacing the hostname with one that resolves to your Unraid server. If the certificate covers the actual server IP, `https://[IP]:[PORT:8080]` can be used instead. Keep the container port at `8080`; the existing host mapping remains `5180` unless you change it.
5. Apply the settings, check the logs, and open `https://<certificate-covered-hostname>:5180` with your chosen host port. Direct TLS automatically uses Secure cookies. Home serves HTTPS on that listener and does not add an HTTP redirect or a second port.

Both TLS fields are required together. An unreadable, mismatched or invalid pair prevents startup; Home does not fall back to plaintext HTTP. Renew the certificate externally and restart Home to load the replacement. The public template keeps an HTTP WebUI default for compatibility, so configure the saved WebUI URL for your chosen HTTPS deployment.

HTTPS protects browser/Agent traffic. It does not encrypt original files at rest or automatically encrypt the host-to-NAS connection. Those are separate storage and network-mount settings; see the [transport encryption boundaries](TRANSPORT_SECURITY.md).

## Back up, recreate and upgrade

Upgrading an existing 0.0.4 installation to 0.0.5 applies additive migration **008** to SQLite or PostgreSQL. Keep the existing Appdata mapping, runtime identity, language and HTTP/reverse-proxy configuration; neither document mounts nor direct-TLS fields are required for the upgrade. Existing navigation and settings remain in the same database. Older 0.0.1 installations also apply migration 007 and its one-time language rules.

The `/data` directory contains `lingshu-home.db`, `csrf.key` and `integrations.key`, along with SQLite runtime files, the instance lock and `document-history` after document editing. Saved icons, document tags/relations and published snapshots are stored in the database. Back up the **complete dedicated data directory** after stopping Home so the database, history and matching keys stay together. Also back up every mounted original directory and its attachments; appdata does not contain those originals. If you configured PostgreSQL, back up that external database as well. A database-only export or a rescan of the Markdown files cannot replace this combined backup.

To recreate the same version, retain the same Appdata host path, user setting and other configuration. Removing a container does not require removing its appdata.

This template uses `latest`, which follows the highest successfully published stable SemVer release. Drafts and prereleases never become `latest`; fixed tags such as `0.0.5` remain available. An installation pinned to an older exact tag needs a one-time **Repository** change to `ghcr.io/zhigege666/lingshu-home:latest` to follow stable releases. Moving `latest` does not itself update a running container. Use Unraid's update action, or your configured update automation, to pull and recreate it after reviewing the upgrade requirements.

An installed container has its own saved template. Updating this repository's template does not replace your configured host paths, language or Repository choice. New optional fields may not appear in that saved configuration; use **Edit** to add the exact Variables and Path mappings above when enabling the new features. There is no need to reinstall Home, delete appdata or replace the complete saved template just to upgrade the image. Check the resulting settings before applying any template refresh.

For a new release:

1. Read its [release notes](https://github.com/zhigege666/Lingshu-Home/releases) and migration requirements.
2. Stop Home and back up its complete data directory, any external database, and mounted original documents/attachments. Keep the previous image and, for a first upgrade from 0.0.1, retain the original **Interface language** value.
3. Use `ghcr.io/zhigege666/lingshu-home:latest` in **Repository** to follow stable releases, or a published exact tag such as `ghcr.io/zhigege666/lingshu-home:0.0.5` to pin a version. Retain `/data`, the same Appdata host path, any existing document/certificate mappings and the `--user=99:100` setting.
4. Apply a Repository change, or use **Check for Updates → Update** for an existing `latest` installation, so Docker Manager pulls the image and recreates the container.
5. Check the logs, open the WebUI, sign in and confirm your existing links and settings.

To roll back from 0.0.5 to 0.0.4, stop Home and restore the matching pre-upgrade database/data backup with the old image. Restoring the database does not undo edits to externally mounted files; restore their matching backups separately. Do not point the older image at the migrated database or delete migration-ledger entries. See [storage and rollback](STORAGE.md).

## Troubleshooting and support

- **Port already allocated:** choose a different host WebUI port. Keep container port `8080`; the WebUI template uses `[PORT:8080]` to find its mapped host port.
- **Permission denied under /data:** check the actual Appdata path, owner, group and permissions for `99:100`. Existing directories are not automatically migrated. Avoid enabling privileged mode or granting world write access as a workaround.
- **Setup appears again:** stop and check the Appdata mapping before initializing a second database. Reusing an image with a different host path does not move existing data.
- **Login fails after enabling secure cookies:** use the configured HTTPS URL, or return the setting to `false` for direct HTTP.
- **WebUI still opens HTTP after enabling direct TLS:** update the saved Advanced View WebUI URL to HTTPS and use a certificate-covered address. The mapped port remains the same.
- **TLS startup fails:** set both file-path Variables, confirm the separate read-only certificate mount and permissions for `99:100`, and check certificate/key matching. Do not put certificates under allowed document roots.
- **Document directory is empty or unavailable:** verify the actual existing host directory/NAS mount, its mapping and permissions, and the JSON container-path allowlist before confirming missing files in Home. A typo may create an empty host directory in Docker Manager.
- **Image pull fails:** confirm the exact repository tag and the host's DNS/network access to GHCR. The template needs the Linux amd64 release.
- **Unclean shutdown or database in use:** check Unraid's global Docker stop timeout as well as the container default, allow at least 30 seconds for shutdown, and ensure only one Home process uses that data directory.

Report installation questions and reproducible bugs in [GitHub Issues](https://github.com/zhigege666/Lingshu-Home/issues). Include your Unraid version, image tag, relevant non-secret settings and redacted logs. Do not attach the database, instance keys, passwords or access tokens.

## Template maintenance

The public installation template is [templates/lingshu-home.xml](../templates/lingshu-home.xml); repository metadata is [ca_profile.xml](../ca_profile.xml). Both are covered by the repository's [Apache-2.0 license](../LICENSE).

Repository publication and Community Applications approval are separate steps. Submit the public repository through [the official submission portal](https://ca.unraid.net/submit) and run **Validate**, then **Scan**, as required by the [official template guide](https://ca.unraid.net/submit/help/repository-xml). Only describe an app as listed after checking its catalog entry.

An equivalent Docker deployment test can verify the image, runtime user and persistence. It does not replace an actual installation through the Unraid WebUI.

Primary references: [Unraid container mappings and variables](https://docs.unraid.net/unraid-os/using-unraid-to/run-docker-containers/managing-and-customizing-containers/), [saved Community Applications settings](https://docs.unraid.net/community-applications/), [template field reference](https://ca.unraid.net/submit/help/xml-field-reference), and [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).
