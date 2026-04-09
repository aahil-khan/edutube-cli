# edutube-cli

Workstation CLI for EduTube: sync the course tree from the API (`pull`), upload lectures to YouTube and register them (`jobs`, `push`), and local SQLite job state.

---

## Recommended install: Node LTS + release tarball (option 1)

Use this for real deployments: **one Node install per machine**, **one `.tgz` artifact** you build once and copy or host internally.

### Prerequisites (every workstation)

1. **[Node.js 20 or newer (LTS)](https://nodejs.org/)** — install the Windows/macOS/Linux installer from nodejs.org.
2. **Secrets are not inside the package.** Operators set **`EDUTUBE_API_KEY`** (and Google OAuth env vars for uploads) via environment, vault, or IT policy — see [Environment variables](#environment-variables).

### Maintainer: build the installable package

From this directory (`edutube-cli/`):

```bash
npm ci
npm run pack:tarball
```

This runs `prepack` → `npm run build`, then creates **`edutube-cli-<version>.tgz`** in the current directory (e.g. `edutube-cli-0.1.0.tgz`).

- **Distribute** that file (internal artifact server, SharePoint, USB, etc.).
- Optionally **publish to a private npm registry** instead of copying the file:

  ```bash
  npm login --registry https://your-registry.example.com
  npm publish --registry https://registry.example.com
  ```

  (Configure `publishConfig` in `package.json` if you always use the same registry.)

### Operator: install globally from the tarball

**Linux / macOS** (adjust the filename to match your version):

```bash
npm install -g ./edutube-cli-0.1.0.tgz
edutube --help
```

**Windows (PowerShell or cmd)** — same idea; use a path to where you saved the `.tgz`:

```bat
npm install -g C:\path\to\edutube-cli-0.1.0.tgz
edutube --help
```

If `edutube` is not found, either restart the terminal or ensure npm’s global `bin` directory is on `PATH` (Node’s installer usually does this). For a **per-user global** install without admin rights:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
# Add ~/.npm-global/bin to PATH in your shell profile, then:
npm install -g ./edutube-cli-0.1.0.tgz
```

### Operator: first-time configuration

1. **Backend URL** — either:
   - run **`edutube init --backend-url https://api.example.com`** inside your course workspace (writes `.edutuberc`), or  
   - set **`EDUTUBE_BACKEND_URL`** in the environment (overrides the file when both are set).
2. **API key** — **`export EDUTUBE_API_KEY=...`** (Unix) or **System / user environment** on Windows.
3. **Smoke test** — from any directory with env set, or after `cd` to a workspace with `.edutuberc`:

   ```bash
   edutube health
   ```

4. **YouTube upload** — set **`EDUTUBE_GOOGLE_CLIENT_ID`** and **`EDUTUBE_GOOGLE_CLIENT_SECRET`**, then **`edutube auth google`**.

---

## Requirements (summary)

- **Node.js 20+**
- **`EDUTUBE_API_KEY`** for API calls (from admin dashboard; never commit it).

Backend URL: **`EDUTUBE_BACKEND_URL`** and/or **`.edutuberc`** (`edutube init`).

---

## ffprobe (bundled)

Probing uses **ffprobe** via [`@ffprobe-installer/ffprobe`](https://www.npmjs.com/package/@ffprobe-installer/ffprobe) (platform binary under `node_modules` at install time).

Resolution order:

1. **`EDUTUBE_FFPROBE_PATH`** — absolute path to override.
2. **Bundled** binary from the installer package.
3. **`ffprobe` on `PATH`** — dev fallback.

Air‑gapped or unsupported arch: install ffmpeg/ffprobe yourself and set **`EDUTUBE_FFPROBE_PATH`**. Bundled ffprobe is LGPL; see upstream notices.

---

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| **`EDUTUBE_API_KEY`** | Yes (for API calls) | `X-CLI-API-Key`. Set in shell, CI secrets, or policy — not in the tarball. |
| **`EDUTUBE_BACKEND_URL`** | Yes* | API base URL, no trailing slash. *Optional if `.edutuberc` sets `backend_url`. Env wins over file. |
| **`EDUTUBE_FFPROBE_PATH`** | No | Override ffprobe binary. |
| **`EDUTUBE_GOOGLE_CLIENT_ID`** / **`EDUTUBE_GOOGLE_CLIENT_SECRET`** | For YouTube upload | OAuth desktop app. |
| **`EDUTUBE_OAUTH_PORT`** | No | `auth google` loopback (default `38475`). |
| **`EDUTUBE_MIN_VIDEO_DURATION_SECONDS`** | No | Default `2`. |
| **`EDUTUBE_LARGE_FILE_WARN_BYTES`** | No | Default 2 GiB. |

OAuth tokens are stored per user (not in the repo):

- **Windows:** `%APPDATA%\edutube\`
- **Linux/macOS:** `$XDG_CONFIG_HOME/edutube` or `~/.config/edutube/`

---

## Install from a git clone (developers)

```bash
cd edutube-cli && npm install && npm run build
npx edutube health
# or: npm link   # global `edutube` from this tree
```

---

## Build tarball only

```bash
npm run pack:tarball
```

Produces `edutube-cli-<version>.tgz` for `npm install -g ./edutube-cli-*.tgz`.

---

## Single-file `.exe` (not supported here)

Bundling with **pkg** / **nexe** needs extra work for native modules (`better-sqlite3`) and ffprobe paths. Prefer **Node + tarball** above unless you invest in a dedicated native build.
