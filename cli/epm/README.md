# epm — Extensions Package Manager

Install, update and seed macros for the **Clicker** extension across *every*
Chrome profile on the machine, from cmd / PowerShell / a Unix terminal.

Written for the pain of doing the same thing by hand eleven times: **Load
unpacked** in each profile, **reload** in each profile after every `git pull`,
and **import the macro JSON** in each profile again and again.

## Why two install modes?

Chrome 150 removed the easy paths, so EPM offers the two that work:

| Mode | Persists across restarts? | All profiles? | Needs hosting? |
|---|---|---|---|
| **`epm policy`** (force-install a `.crx`) | yes | yes | yes — HTTPS |
| **`epm install`** (DevTools Protocol, session) | no | no — the profile it launches | no |

The persistent route is Chrome's own `ExtensionInstallForcelist` policy, the
same mechanism enterprises use. The session route uses
`Extensions.loadUnpacked` over the DevTools pipe, which loads the extension
without any clicking but is dropped when Chrome closes.

Macro import (`epm import`) works with either mode.

## Setup

No npm dependencies — just Node.js ≥ 18 and git.

```bash
./setup.sh            # macOS / Linux
setup.cmd             # Windows (runs setup.ps1)
```

Both check for Node and git and try to install them if missing, then put `epm`
on your PATH.

## Persistent install (recommended)

```bash
# 1. Give the extension a stable id (writes "key" into manifest.json; do this once).
epm keygen

# 2. Build the signed package. Host the two files it writes over HTTPS.
epm pack --base-url https://<you>.github.io/clicker-epm
#   -> ~/.epm/dist/clicker-macrobat-<version>.crx
#   -> ~/.epm/dist/updates.xml
# commit manifest.json, push dist/ to your hosting (GitHub Pages, a Release, ...)

# 3. Point the policy at the hosted update manifest.
epm policy install --update-url https://<you>.github.io/clicker-epm/updates.xml
#    Linux needs root for /etc/opt/chrome/policies; Windows uses HKCU by default
#    (--machine for HKLM); macOS writes the com.google.Chrome default.

# 4. Restart Chrome. Every profile installs it and keeps it.
```

Updating is then: bump `"version"` in `manifest.json` → `epm pack` → push. Chrome
picks up the new version on its own.

## Session install (no hosting)

Chrome must be **closed** for these.

```bash
epm install                    # load into every profile, this session only
epm update                     # git pull, then reload in every profile
epm import macros.json         # import a Backup export  (--mode replace to overwrite)
```

## Commands

```
epm pack [--base-url u] [--crx-url u] [--out dir]   Build .crx + updates.xml
epm policy install --update-url <url>               Force-install across all profiles
epm policy uninstall                                Remove the policy entry
epm policy status                                   Show the policy target on this OS
epm install [--profile p] [--headless]              Load for the current session
epm update  [--profile p]                           git pull + reload (session)
epm import <file.json> [--mode merge|replace]       Bulk-import macros into every profile
epm keygen [--force]                                Add a stable "key" to manifest.json
epm profiles                                        List browsers and profiles
epm status                                          Where the extension is installed
epm source [clone|pull|status]                      Manage the git checkout
epm doctor                                          Environment + config check
```

Global options: `--profile <name>` (repeatable), `--source <path>`,
`--browser <path>`, `--user-data-dir <path>`, `--help`.

## Configuration

Defaults to the repo `https://github.com/ghiffarsabda/clicker.git`, cloned to
`~/.epm/clicker`. Override any of it in `~/.epm/config.json`:

```json
{
  "repo": "https://github.com/ghiffarsabda/clicker.git",
  "branch": "main",
  "source": "~/.epm/clicker",
  "browser": null,
  "userDataDir": null
}
```

## Good to know

- **`epm keygen` changes the extension id once.** Existing unpacked copies become
  a different extension; reinstall and re-import macros afterwards.
- The force-installed extension shows Chrome's *"managed by your organisation"*
  notice — that is the normal signal for a policy-installed extension.
- `pack` uses Chrome itself to sign the `.crx`, so the CRX id always matches the
  `key` in `manifest.json` (and therefore the policy id).
- Session commands write to `chrome.storage.local` through the DevTools Protocol,
  so Chrome must be closed; `policy`/`pack`/`keygen` do not need it closed.
- Chrome, Chromium, Edge and Brave are detected. Policy paths per browser are in
  `src/policy.js`.
