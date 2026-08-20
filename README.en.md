# DSH Session Vault

[中文](README.md) · [English](README.en.md)

An open-source session-management plugin for **DeepSeek Harness (DSH) `0.1.0-rc.7`**. It brings active sessions, archived sessions, and a recoverable trash area into one settings page without registering model tools, changing Router presets, or injecting into the page DOM.

> **Default language: Chinese**　[切换到中文](README.md)

## Contents

- [Features](#features)
- [Compatibility](#compatibility)
- [Installation](#installation)
- [Usage](#usage)
- [Data and security](#data-and-security)
- [Troubleshooting](#troubleshooting)
- [Development and testing](#development-and-testing)
- [Architecture](#architecture)
- [License](#license)

## Features

### 1. One place for three session states

The plugin adds **Settings → Session Vault** with three tabs:

- **Active**: sessions that are not archived;
- **Archived**: sessions hidden from the normal view but still retained;
- **Trash**: session records moved out of the primary session directory while remaining recoverable.

### 2. Search and batch actions

Search by title, session ID, or working directory. Select the current results and batch archive, unarchive, move to trash, restore, or permanently purge them. Running sessions are marked and blocked from destructive actions.

### 3. Recoverable deletion

Moving a session to trash is not immediate destruction. The plugin moves only the DSH-owned session-record directory into a dedicated trash directory and stores its original path, title, size, and archive state. Restore moves it back to the original location. If that location already contains a same-name record, the plugin refuses to overwrite it.

### 4. No arbitrary trash limit

The plugin never deletes old entries just because the trash reaches a fixed count. The practical limit is available disk space, and cleanup remains an explicit user decision.

### 5. Confirmed purge with crash recovery

Permanent purge is available only for trash entries and requires an explicit confirmation. The Host uses a two-phase flow—stage, commit metadata, then remove files. If DSH exits in the middle, the next startup reconciles the staging directory and either restores or completes the pending operation.

### 6. Workspace files are left alone

Permanent purge removes DSH session persistence and the related projection-cache row only. It does not remove workspace source code, downloads, build outputs, or other files created by the user.

### 7. Small integration surface

- No model tools;
- No model-visible prompt section;
- No DOM injection;
- No changes to Router Standard/Spec, model endpoints, search plugins, visual plugins, or skills;
- Host API accepts only loopback, same-origin requests.

## Compatibility

| Component | Requirement |
| --- | --- |
| DSH | `0.1.0-rc.7` |
| Node.js | `22.19+` or `24+` |
| Profile | `web` |
| Storage | DSH Web's default JSON storage/domain composition |
| Persistence | A `sessionPersistence` provider that exposes an independent record path |

Unarchive relies on the rc.7 `workspaceRegistry.requireState()` / `setState()` primitives, so older DSH releases are not supported. With a custom persistence backend that cannot locate an independent session directory, the plugin rejects the operation instead of guessing a path or deleting unknown files.

## Installation

### Install from GitHub (recommended)

Run this in WSL or the environment where DSH is installed:

```bash
dsh plugin --profile web add github:fujunchao/dsh-session-vault
```

Restart the Web service:

```bash
sudo systemctl restart dsh-web.service
```

On a non-systemd setup, stop the current `dsh web` process and start `dsh web` again.

### Install a local development link

```bash
dsh plugin --profile web add 'link:/absolute/path/to/dsh-session-vault'
sudo systemctl restart dsh-web.service
```

### Verify the installation

```bash
dsh plugin --profile web list
```

The list should contain:

```text
dsh-session-vault
```

Then open **Settings → Session Vault**. This is a normal DSH Host/Client plugin and is **not managed by `dsh-super-injector`**. Therefore, “0 injected plugins” in the Super Injector page is expected and does not mean the plugin failed to load.

## Usage

### Archive a session

1. Open **Settings → Session Vault → Active**;
2. Select one or more sessions;
3. Click **Archive**.

Archiving changes DSH visibility/workspace state only; it does not delete the record. To show it again, open **Archived** and click **Unarchive**.

### Move sessions to trash

1. Select sessions in **Active** or **Archived**;
2. Click **Move to trash**;
3. Wait for the operation to finish.

Running sessions, sessions still open in the current DSH process, and sessions without a safely locatable persistence directory are never force-deleted. End the session or restart DSH before retrying.

### Restore a session

1. Open the **Trash** tab;
2. Select the session;
3. Click **Restore**.

The original directory and archive state are restored. If the original location is occupied, restore fails without overwriting either copy.

### Permanently purge

1. Select entries in **Trash**;
2. Click **Permanently purge**;
3. Read the warning and check the acknowledgement box;
4. Confirm the operation.

This operation is irreversible and applies only to DSH session records already in the trash. Review the conversation before purging if you may need it later.

### Search and batch actions

The search box matches:

- Session title;
- `session-...` ID;
- Working-directory path.

**Select all current results** is scoped to the current tab and filter; it does not accidentally select entries in another tab.

## Data and security

### File locations

| Path | Purpose |
| --- | --- |
| `~/.dsh/storages/dsh_session_vault.json` | Trash metadata (created after the first stored entry) |
| `~/.dsh/session-vault/trash/<session-id>/` | Recoverable session-record directory |
| `~/.dsh/session-vault/purging/<session-id>/` | Transaction staging directory for permanent purge |
| `~/.dsh/sessions/` | Original DSH session records maintained by DSH |

The repository contains no API keys, model endpoints, or credentials. It does not read or upload the search plugin's credentials, and its fixtures/tests contain no user session data.

### Host API boundary

The internal API prefix is `/dsh-session-vault/api`:

- `GET /snapshot`: read the session and trash snapshot;
- `POST /batch`: execute a batch action with `{ "action": "...", "sessionIds": [...] }`.

These are not public APIs. The plugin validates the remote address, `Host`, `Origin`, and Fetch Metadata and accepts only same-origin loopback requests. Do not expose the DSH Web port to the public Internet or an untrusted LAN; this API does not provide account authentication.

## Troubleshooting

### “Session Vault” is missing from Settings

1. Confirm `dsh-session-vault` appears in `dsh plugin --profile web list`;
2. Restart the DSH Web service;
3. Hard-refresh the browser settings page;
4. Inspect `journalctl -u dsh-web.service -n 100` for loader errors.

### Super Injector shows zero plugins

This is expected. The plugin is mounted through the profile's standard bundle, not the Super Injector directory-injection list. Use **Settings → Plugins → Plugin list** (look for `session-vault`) and **Settings → Session Vault** as the authoritative checks.

### A session cannot be moved to trash

The session may still be running/open, or the persistence backend may not expose an independent directory. End the session and restart DSH, then retry. The plugin deliberately never guesses a path from a delete request.

### `cannot get property "storageDomain" without inject`

This indicates an old bundle or stale entry metadata. Reinstall the GitHub version and restart DSH:

```bash
dsh plugin --profile web remove dsh-session-vault
dsh plugin --profile web add github:fujunchao/dsh-session-vault
sudo systemctl restart dsh-web.service
```

### A purging directory remains after a purge

Do not remove `purging/<session-id>` by hand. On the next DSH startup the plugin scans the staging directory and completes or rolls back the unfinished transaction. If it still fails, preserve the logs and open an Issue.

## Development and testing

```bash
git clone https://github.com/fujunchao/dsh-session-vault.git
cd dsh-session-vault
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs:

1. TypeScript type checking;
2. Vitest unit tests;
3. Host/Client builds;
4. Host/Client bundle smoke tests.

Source layout:

```text
src/index.ts       Host plugin, API, and filesystem transactions
src/client.tsx     Settings UI
src/core.ts        Path, session-ID, and request-boundary validation
src/contract.ts    Shared Host/Client types
tests/             Unit and bundle smoke tests
lib/               Built artifacts loaded by DSH and shipped in releases
```

Run the build after changing the TypeScript sources. DSH loads the built `lib/` artifacts; it does not execute the TypeScript source directly.

## Architecture

The plugin has two standard entry points:

- **Host**: injects `webServer`, `sessionPersistence`, `workspaceRegistry`, `agents`, and `storageDomain` for the API and safe session-directory operations;
- **Client**: injects DSH slots, locale, sessions, and workspaces, and registers exactly one `settings.section`.

There is no model-tool entry point and no Super Injector-specific entry point.

## License

[MIT License](LICENSE)

Issues and pull requests are welcome. Remove conversation content, API keys, credentials, and private paths before sharing diagnostics.

