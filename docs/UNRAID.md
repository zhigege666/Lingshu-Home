# Unraid installation

**English** | [简体中文](UNRAID.zh-CN.md)

Lingshu-Home provides a Docker template for Unraid's Docker Manager and Community Applications. The template selects the **Linux amd64 (x86-64)** image `ghcr.io/zhigege666/lingshu-home:latest`, following published stable releases with embedded SQLite. No external database is required. Exact version tags such as `0.0.2` remain available.

These instructions target **0.0.2**. Its language is chosen once and saved in the database. Before upgrading an existing 0.0.1 instance, read the language and migration-007 backup requirements below.

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
| Appdata | `/mnt/user/appdata/lingshu-home` → `/data` | Database, saved icons and instance keys. Retain this mapping during container replacement. |
| Interface language | `en` | Choose `en` or `zh-CN` before the first start or first upgrade from 0.0.1. A saved instance language takes precedence on later starts. |
| HTTPS-only cookies | `false` | Advanced setting. Use `true` only when accessing Home through an HTTPS reverse proxy. |

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

For remote access, configure an HTTPS reverse proxy, then set **HTTPS-only cookies** to `true`. That setting controls cookie transport; it does not enable TLS in Home. Keep it `false` when using the direct HTTP WebUI, or the browser cannot use secure login cookies over HTTP.

## Back up, recreate and upgrade

The `/data` directory contains `lingshu-home.db`, `csrf.key` and `integrations.key`, along with SQLite runtime files and the instance lock. Saved website and custom icon bytes are stored in the database. Back up the **complete dedicated data directory** after stopping Home so the database and its matching keys stay together. A database-only export does not replace this backup.

To recreate the same version, retain the same Appdata host path, user setting and other configuration. Removing a container does not require removing its appdata.

This template uses `latest`, which follows the highest successfully published stable SemVer release. Drafts and prereleases never become `latest`; fixed tags such as `0.0.2` remain available. An installation pinned to `0.0.1` or `0.0.2` needs a one-time **Repository** change to `ghcr.io/zhigege666/lingshu-home:latest` to follow stable releases. Updating a catalog template does not change an installed container's Repository, and moving `latest` does not itself update a running container. Use Unraid's update action, or your configured update automation, to pull and recreate it after reviewing the upgrade requirements.

For a new release:

1. Read its [release notes](https://github.com/zhigege666/Lingshu-Home/releases) and migration requirements.
2. Stop Home and back up its complete data directory. Keep the previous image and, for a first upgrade from 0.0.1, retain the original **Interface language** value.
3. Use `ghcr.io/zhigege666/lingshu-home:latest` in **Repository** to follow stable releases, or a published exact tag such as `ghcr.io/zhigege666/lingshu-home:0.0.2` to pin a version. Retain `/data`, the same Appdata host path and the `--user=99:100` setting.
4. Apply a Repository change, or use **Check for Updates → Update** for an existing `latest` installation, so Docker Manager pulls the image and recreates the container.
5. Check the logs, open the WebUI, sign in and confirm your existing links and settings.

A newer version may migrate the database. Do not switch to an older image against migrated data unless its documented downgrade procedure permits it. Keep the pre-upgrade backup.

## Troubleshooting and support

- **Port already allocated:** choose a different host WebUI port. Keep container port `8080`; the WebUI template uses `[PORT:8080]` to find its mapped host port.
- **Permission denied under /data:** check the actual Appdata path, owner, group and permissions for `99:100`. Existing directories are not automatically migrated. Avoid enabling privileged mode or granting world write access as a workaround.
- **Setup appears again:** stop and check the Appdata mapping before initializing a second database. Reusing an image with a different host path does not move existing data.
- **Login fails after enabling secure cookies:** use your HTTPS proxy URL, or return the setting to `false` for direct HTTP.
- **Image pull fails:** confirm the exact repository tag and the host's DNS/network access to GHCR. The template needs the Linux amd64 release.
- **Unclean shutdown or database in use:** check Unraid's global Docker stop timeout as well as the container default, allow at least 30 seconds for shutdown, and ensure only one Home process uses that data directory.

Report installation questions and reproducible bugs in [GitHub Issues](https://github.com/zhigege666/Lingshu-Home/issues). Include your Unraid version, image tag, relevant non-secret settings and redacted logs. Do not attach the database, instance keys, passwords or access tokens.

## Template maintenance

The public installation template is [templates/lingshu-home.xml](../templates/lingshu-home.xml); repository metadata is [ca_profile.xml](../ca_profile.xml). Both are covered by the repository's [Apache-2.0 license](../LICENSE).

Repository publication and Community Applications approval are separate steps. Submit the public repository through [the official submission portal](https://ca.unraid.net/submit) and run **Validate**, then **Scan**, as required by the [official template guide](https://ca.unraid.net/submit/help/repository-xml). Only describe an app as listed after checking its catalog entry.

An equivalent Docker deployment test can verify the image, runtime user and persistence. It does not replace an actual installation through the Unraid WebUI.
