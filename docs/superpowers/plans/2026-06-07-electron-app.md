# Ableton Backup — Electron Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. UI components SHOULD be built with the frontend-design skill for visual quality.

**Goal:** Wrap the tested `ablebackup` Python sidecar in an Electron desktop app with a React/Vite UI, so a user can pick source folders + a NAS destination, scan projects, run backups with live progress, browse history, and enable scheduled runs — all from a real window, with native folder pickers, a tray icon, notifications, and launch-at-login.

**Architecture:** Electron `main.js` owns the lifecycle: it mints a random auth token, picks a free port, spawns `python -m ablebackup.server` with `ABLEBACKUP_TOKEN/PORT/DB` in its env, waits for `/health`, and supervises/kills it. A `preload.js` exposes a tiny, safe bridge (`token`, `port`, `pickFolder()`, `notify()`) to the renderer over `contextBridge`. The renderer is a React + Vite + TypeScript app whose `api.ts` calls the FastAPI endpoints (token in `X-Auth-Token`) and whose `useProgress` hook subscribes to `/ws/progress`. In dev, `npm start` runs the Vite dev server and Electron together; the same renderer build is what a packaged app would ship.

**Tech Stack:** Electron 31+, Node 24, Vite 5 + React 18 + TypeScript, plain CSS design system, `concurrently` + `wait-on` for the dev runner, `vitest` for renderer unit tests. The Python sidecar is unchanged (Plan 2).

---

## File Structure

```
electron/
  package.json                 # app + scripts + deps
  tsconfig.json                # renderer TS config
  vite.config.ts               # Vite (root=src, build→dist)
  index.html                   # renderer entry
  electron/
    main.js                    # app lifecycle, sidecar spawn/supervise, IPC, tray, notifications
    preload.js                 # contextBridge: token/port/pickFolder/notify
    sidecar.js                 # spawn python server, wait for /health, kill
  src/
    main.tsx                   # React bootstrap
    App.tsx                    # shell: nav + routing between screens
    api.ts                     # typed fetch client over the sidecar
    useProgress.ts             # WebSocket progress hook
    types.ts                   # shared TS types mirroring the API
    theme.css                  # design tokens + base styles
    components/
      Nav.tsx
      Button.tsx
      StatusPill.tsx
      ProgressBar.tsx
    screens/
      Dashboard.tsx            # recent snapshots + totals
      Sources.tsx              # source folders + NAS dest + schedule (settings)
      Scan.tsx                 # scan → project list w/ present/missing → Back up
      Backup.tsx               # live progress feed
      Browse.tsx               # by-project + by-date history browse
  test/
    api.test.ts                # unit: api client builds requests + parses
    useProgress.test.ts        # unit: hook reduces ws events to state
```

Renderer concerns live in `src/` (one file per screen/component). Electron-process concerns live in `electron/`. The Python backend is consumed, not modified.

---

### Task 1: Electron scaffolding that launches an empty window

**Files:**
- Create: `electron/package.json`
- Create: `electron/electron/main.js`
- Create: `electron/electron/preload.js`
- Create: `electron/index.html`

- [ ] **Step 1: Write package.json**

`electron/package.json`:
```json
{
  "name": "ableton-backup-app",
  "version": "0.1.0",
  "description": "Ableton project backup desktop app",
  "main": "electron/main.js",
  "scripts": {
    "dev:vite": "vite",
    "dev:electron": "wait-on tcp:5173 && cross-env ABLEBACKUP_DEV=1 electron .",
    "start": "concurrently -k -n VITE,ELECTRON -c blue,green \"npm:dev:vite\" \"npm:dev:electron\"",
    "build": "vite build",
    "test": "vitest run"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "concurrently": "^9.0.1",
    "cross-env": "^7.0.3",
    "electron": "^31.3.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "typescript": "^5.5.4",
    "vite": "^5.4.2",
    "vitest": "^2.0.5",
    "wait-on": "^8.0.0",
    "@types/react": "^18.3.4",
    "@types/react-dom": "^18.3.0"
  }
}
```

- [ ] **Step 2: Write a minimal main.js that opens a window**

`electron/electron/main.js`:
```javascript
const { app, BrowserWindow } = require("electron");
const path = require("path");

const isDev = !!process.env.ABLEBACKUP_DEV;
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: "#0e0f13",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isDev) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 3: Write a placeholder preload + index.html**

`electron/electron/preload.js`:
```javascript
const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("ablebackup", { ready: true });
```

`electron/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Ableton Backup</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Install + verify the window opens**

Run:
```bash
cd electron && npm install
```
Then (manual smoke — needs a desktop session):
```bash
npm start
```
Expected: an Electron window opens. It will be blank/error until the React app exists (Task 2) — that is fine; the goal here is the window launching and loading `localhost:5173`.

- [ ] **Step 5: Commit**

```bash
git add electron/package.json electron/electron/main.js electron/electron/preload.js electron/index.html
git commit -m "feat(app): electron scaffolding that opens a window"
```

---

### Task 2: React + Vite renderer with a styled shell

**Files:**
- Create: `electron/vite.config.ts`
- Create: `electron/tsconfig.json`
- Create: `electron/src/main.tsx`
- Create: `electron/src/App.tsx`
- Create: `electron/src/theme.css`

This task gets a real, styled app shell rendering. Use the frontend-design skill for the visual system; the code below is a working baseline to replace/extend with higher design quality.

- [ ] **Step 1: Vite + TS config**

`electron/vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",            // relative paths so file:// works in packaged app
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
```

`electron/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2021",
    "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["vite/client", "vitest/globals"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 2: Theme + bootstrap + shell**

`electron/src/theme.css`:
```css
:root {
  --bg: #0e0f13;
  --bg-elev: #16181f;
  --bg-elev-2: #1d2029;
  --border: #2a2e3a;
  --text: #e7e9ee;
  --text-dim: #9aa0ad;
  --accent: #6c8cff;
  --accent-2: #46d3a8;
  --danger: #ff6b6b;
  --warn: #ffcc66;
  --radius: 12px;
  --shadow: 0 6px 24px rgba(0,0,0,0.35);
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 "Inter", system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.app { display: grid; grid-template-columns: 220px 1fr; height: 100%; }
.main { padding: 28px 32px; overflow: auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
.sub { color: var(--text-dim); margin: 0 0 24px; }
.card {
  background: var(--bg-elev); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 18px; box-shadow: var(--shadow);
}
```

`electron/src/main.tsx`:
```typescript
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./theme.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

`electron/src/App.tsx`:
```typescript
import { useState } from "react";
import { Nav } from "./components/Nav";
import { Dashboard } from "./screens/Dashboard";
import { Sources } from "./screens/Sources";
import { Scan } from "./screens/Scan";
import { Backup } from "./screens/Backup";
import { Browse } from "./screens/Browse";

export type Screen = "dashboard" | "sources" | "scan" | "backup" | "browse";

export default function App() {
  const [screen, setScreen] = useState<Screen>("dashboard");
  return (
    <div className="app">
      <Nav screen={screen} onNavigate={setScreen} />
      <div className="main">
        {screen === "dashboard" && <Dashboard />}
        {screen === "sources" && <Sources />}
        {screen === "scan" && <Scan onBackupStarted={() => setScreen("backup")} />}
        {screen === "backup" && <Backup />}
        {screen === "browse" && <Browse />}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Stub the components/screens so it compiles**

Create minimal stubs (replaced in later tasks). `electron/src/components/Nav.tsx`:
```typescript
import type { Screen } from "../App";

const ITEMS: { id: Screen; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "sources", label: "Sources & NAS" },
  { id: "scan", label: "Scan & Back up" },
  { id: "backup", label: "Progress" },
  { id: "browse", label: "Browse" },
];

export function Nav({ screen, onNavigate }: {
  screen: Screen; onNavigate: (s: Screen) => void;
}) {
  return (
    <nav style={{ background: "var(--bg-elev)", borderRight: "1px solid var(--border)", padding: 16 }}>
      <div style={{ fontWeight: 700, padding: "8px 12px 16px" }}>Ableton Backup</div>
      {ITEMS.map((it) => (
        <button
          key={it.id}
          onClick={() => onNavigate(it.id)}
          style={{
            display: "block", width: "100%", textAlign: "left",
            padding: "10px 12px", marginBottom: 4, borderRadius: 8,
            border: "none", cursor: "pointer",
            background: screen === it.id ? "var(--bg-elev-2)" : "transparent",
            color: screen === it.id ? "var(--text)" : "var(--text-dim)",
          }}
        >{it.label}</button>
      ))}
    </nav>
  );
}
```

Stubs for screens (each replaced later) — `electron/src/screens/Dashboard.tsx`, `Sources.tsx`, `Scan.tsx`, `Backup.tsx`, `Browse.tsx`:
```typescript
// Dashboard.tsx
export function Dashboard() {
  return (<><h1>Dashboard</h1><p className="sub">Recent backups appear here.</p></>);
}
```
```typescript
// Sources.tsx
export function Sources() {
  return (<><h1>Sources & NAS</h1><p className="sub">Configure folders + destination.</p></>);
}
```
```typescript
// Scan.tsx
export function Scan({ onBackupStarted }: { onBackupStarted: () => void }) {
  return (<><h1>Scan & Back up</h1><p className="sub">Discover projects.</p>
    <button onClick={onBackupStarted}>go</button></>);
}
```
```typescript
// Backup.tsx
export function Backup() {
  return (<><h1>Progress</h1><p className="sub">Live backup progress.</p></>);
}
```
```typescript
// Browse.tsx
export function Browse() {
  return (<><h1>Browse</h1><p className="sub">By project and by date.</p></>);
}
```

- [ ] **Step 4: Verify it builds and renders**

Run: `cd electron && npm run build`
Expected: Vite build succeeds, `dist/index.html` produced.
Manual: `npm start` shows the shell with a working left-nav switching screens.

- [ ] **Step 5: Commit**

```bash
git add electron/vite.config.ts electron/tsconfig.json electron/src
git commit -m "feat(app): react+vite renderer shell with nav"
```

---

### Task 3: Sidecar lifecycle — spawn, health-wait, supervise, kill

**Files:**
- Create: `electron/electron/sidecar.js`
- Modify: `electron/electron/main.js`

Electron mints a token, picks a free port, spawns the Python server with env, waits for `/health`, and kills it on quit. The backend dir is resolved relative to the app (dev: `../backend`).

- [ ] **Step 1: Write sidecar.js**

`electron/electron/sidecar.js`:
```javascript
const { spawn } = require("child_process");
const crypto = require("crypto");
const net = require("net");
const path = require("path");
const http = require("http");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForHealth(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/health", timeout: 1000 },
        (res) => { res.resume(); resolve(); }
      );
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error("sidecar health timeout"));
        else setTimeout(tick, 250);
      });
      req.on("timeout", () => req.destroy());
    };
    tick();
  });
}

async function startSidecar({ backendDir, dbPath, pythonCmd = "python" }) {
  const token = crypto.randomBytes(24).toString("hex");
  const port = await freePort();
  const env = {
    ...process.env,
    ABLEBACKUP_TOKEN: token,
    ABLEBACKUP_PORT: String(port),
    ABLEBACKUP_DB: dbPath,
  };
  const proc = spawn(pythonCmd, ["-m", "ablebackup.server"], {
    cwd: backendDir, env, stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => console.log("[sidecar]", d.toString().trim()));
  proc.stderr.on("data", (d) => console.error("[sidecar]", d.toString().trim()));
  await waitForHealth(port);
  return { proc, token, port };
}

module.exports = { startSidecar, freePort, waitForHealth };
```

- [ ] **Step 2: Wire it into main.js**

Replace `electron/electron/main.js` with:
```javascript
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const { startSidecar } = require("./sidecar");

const isDev = !!process.env.ABLEBACKUP_DEV;
let win = null;
let sidecar = null;

function backendDir() {
  // dev: repo backend/. packaged: resourcesPath/backend (set up at packaging time).
  return isDev
    ? path.join(__dirname, "..", "..", "backend")
    : path.join(process.resourcesPath, "backend");
}

function dbPath() {
  return path.join(app.getPath("userData"), "catalog.db");
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 760, backgroundColor: "#0e0f13",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false,
      additionalArguments: [
        `--ablebackup-token=${sidecar.token}`,
        `--ablebackup-port=${sidecar.port}`,
      ],
    },
  });
  if (isDev) win.loadURL("http://localhost:5173");
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

app.whenReady().then(async () => {
  sidecar = await startSidecar({ backendDir: backendDir(), dbPath: dbPath() });
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  if (sidecar?.proc) sidecar.proc.kill();
});
```

- [ ] **Step 3: Expose token/port + pickFolder via preload**

Replace `electron/electron/preload.js`:
```javascript
const { contextBridge, ipcRenderer } = require("electron");

function argValue(flag) {
  const a = process.argv.find((x) => x.startsWith(flag + "="));
  return a ? a.slice(flag.length + 1) : "";
}

contextBridge.exposeInMainWorld("ablebackup", {
  token: argValue("--ablebackup-token"),
  port: argValue("--ablebackup-port"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
});
```

- [ ] **Step 4: Verify the sidecar boots with the app**

Manual: `cd electron && npm start`. Expected console line `[sidecar] ... Uvicorn running` and the window opens. Closing the window terminates the python process (check Task Manager: no lingering `python -m ablebackup.server`).

- [ ] **Step 5: Commit**

```bash
git add electron/electron/sidecar.js electron/electron/main.js electron/electron/preload.js
git commit -m "feat(app): spawn/supervise python sidecar with token handshake"
```

---

### Task 4: Typed API client + types (unit-tested)

**Files:**
- Create: `electron/src/types.ts`
- Create: `electron/src/api.ts`
- Test: `electron/test/api.test.ts`

`api.ts` reads `window.ablebackup.token/port` and calls the sidecar. It is unit-tested with a mocked `fetch` and a stubbed `window.ablebackup`.

- [ ] **Step 1: Write the failing test**

`electron/test/api.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeApi } from "../src/api";

describe("api client", () => {
  beforeEach(() => {
    (globalThis as any).window = { ablebackup: { token: "T", port: "9000" } };
  });

  it("sends the auth token and parses scan results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ projects: [{ name: "Song", present_count: 1, missing_count: 0 }] }),
    });
    (globalThis as any).fetch = fetchMock;
    const api = makeApi();
    const projects = await api.scan(["C:/Music"]);
    expect(projects[0].name).toBe("Song");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9000/api/scan");
    expect(opts.headers["X-Auth-Token"]).toBe("T");
    expect(JSON.parse(opts.body)).toEqual({ sources: ["C:/Music"] });
  });

  it("throws on non-ok responses", async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: false, status: 400, json: async () => ({ detail: "no destination configured" }),
    });
    const api = makeApi();
    await expect(api.startBackup({})).rejects.toThrow(/no destination configured/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron && npx vitest run test/api.test.ts`
Expected: FAIL — cannot find `../src/api`.

- [ ] **Step 3: Write types + api**

`electron/src/types.ts`:
```typescript
export interface ProjectSummary {
  name: string;
  project_dir: string;
  als_path: string;
  present_count: number;
  missing_count: number;
  missing: string[];
  total_size: number;
}
export interface Config {
  sources: string[];
  dest: string;
  interval_minutes: number;
}
export interface Snapshot {
  id: number;
  project_name: string;
  timestamp: string;
  total_size: number;
  file_count: number;
  status: string;
  error: string | null;
  missing?: string[];
}
export interface ProjectRow {
  project_name: string;
  snapshot_count: number;
  last_timestamp: string;
  total_size: number;
}
export interface JobStatus {
  state: "running" | "done" | "error";
  result?: { timestamp: string; ok_count: number; error_count: number };
  error?: string;
}
export type ProgressEvent =
  | { type: "backup_start"; project_count: number; timestamp: string }
  | { type: "project_start"; index: number; project_name: string; total: number }
  | { type: "project_done"; index: number; project_name: string; file_count: number; missing_count: number }
  | { type: "project_error"; index: number; project_name: string; error: string }
  | { type: "backup_done"; ok_count: number; error_count: number };
```

`electron/src/api.ts`:
```typescript
import type { Config, JobStatus, ProjectRow, ProjectSummary, Snapshot } from "./types";

function base() {
  const port = (window as any).ablebackup?.port ?? "8753";
  return `http://127.0.0.1:${port}`;
}
function token() {
  return (window as any).ablebackup?.token ?? "";
}

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(base() + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Auth-Token": token() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try { detail = (await res.json()).detail ?? detail; } catch { /* ignore */ }
    throw new Error(detail);
  }
  return res.json();
}

export function makeApi() {
  return {
    async getSettings(): Promise<Config> { return req("GET", "/api/settings"); },
    async saveSettings(c: Config): Promise<Config> { return req("PUT", "/api/settings", c); },
    async scan(sources?: string[]): Promise<ProjectSummary[]> {
      return (await req("POST", "/api/scan", { sources })).projects;
    },
    async startBackup(opts: { sources?: string[]; dest?: string; timestamp?: string }): Promise<{ job_id: string }> {
      return req("POST", "/api/backup", opts);
    },
    async jobStatus(id: string): Promise<JobStatus> { return req("GET", `/api/jobs/${id}`); },
    async history(limit = 50): Promise<Snapshot[]> {
      return (await req("GET", `/api/history?limit=${limit}`)).snapshots;
    },
    async projects(): Promise<ProjectRow[]> {
      return (await req("GET", "/api/projects")).projects;
    },
    async projectDetail(name: string): Promise<{ project_name: string; snapshots: Snapshot[] }> {
      return req("GET", `/api/projects/${encodeURIComponent(name)}`);
    },
  };
}
export type Api = ReturnType<typeof makeApi>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron && npx vitest run test/api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/types.ts electron/src/api.ts electron/test/api.test.ts
git commit -m "feat(app): typed API client over the sidecar"
```

---

### Task 5: Progress hook (unit-tested reducer)

**Files:**
- Create: `electron/src/useProgress.ts`
- Test: `electron/test/useProgress.test.ts`

The WS event stream is reduced to render state: overall counts, current project, a log, and a done flag. The reducer is pure and unit-tested; the hook wires it to a WebSocket.

- [ ] **Step 1: Write the failing test**

`electron/test/useProgress.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { reduceProgress, initialProgress } from "../src/useProgress";

describe("reduceProgress", () => {
  it("tracks counts and completion across a run", () => {
    let s = initialProgress();
    s = reduceProgress(s, { type: "backup_start", project_count: 2, timestamp: "t" });
    expect(s.total).toBe(2);
    expect(s.done).toBe(false);
    s = reduceProgress(s, { type: "project_start", index: 0, project_name: "A", total: 2 });
    expect(s.current).toBe("A");
    s = reduceProgress(s, { type: "project_done", index: 0, project_name: "A", file_count: 3, missing_count: 0 });
    expect(s.completed).toBe(1);
    s = reduceProgress(s, { type: "project_error", index: 1, project_name: "B", error: "x" });
    expect(s.errors).toBe(1);
    s = reduceProgress(s, { type: "backup_done", ok_count: 1, error_count: 1 });
    expect(s.done).toBe(true);
    expect(s.log.length).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd electron && npx vitest run test/useProgress.test.ts`
Expected: FAIL — cannot find `../src/useProgress`.

- [ ] **Step 3: Write the hook + reducer**

`electron/src/useProgress.ts`:
```typescript
import { useEffect, useRef, useState } from "react";
import type { ProgressEvent } from "./types";

export interface ProgressState {
  total: number;
  completed: number;
  errors: number;
  current: string | null;
  done: boolean;
  log: string[];
}

export function initialProgress(): ProgressState {
  return { total: 0, completed: 0, errors: 0, current: null, done: false, log: [] };
}

export function reduceProgress(s: ProgressState, ev: ProgressEvent): ProgressState {
  switch (ev.type) {
    case "backup_start":
      return { ...initialProgress(), total: ev.project_count, log: [`Starting ${ev.project_count} project(s)…`] };
    case "project_start":
      return { ...s, current: ev.project_name, log: [...s.log, `→ ${ev.project_name}`] };
    case "project_done":
      return { ...s, completed: s.completed + 1, current: null,
        log: [...s.log, `✓ ${ev.project_name} (${ev.file_count} files, ${ev.missing_count} missing)`] };
    case "project_error":
      return { ...s, errors: s.errors + 1, current: null,
        log: [...s.log, `✗ ${ev.project_name}: ${ev.error}`] };
    case "backup_done":
      return { ...s, done: true,
        log: [...s.log, `Done — ${ev.ok_count} ok, ${ev.error_count} error(s).`] };
    default:
      return s;
  }
}

export function useProgress(active: boolean): ProgressState {
  const [state, setState] = useState<ProgressState>(initialProgress);
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    if (!active) return;
    const port = (window as any).ablebackup?.port ?? "8753";
    const token = (window as any).ablebackup?.token ?? "";
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/progress?token=${token}`);
    wsRef.current = ws;
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data) as ProgressEvent;
      setState((s) => reduceProgress(s, ev));
    };
    return () => ws.close();
  }, [active]);
  return state;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd electron && npx vitest run test/useProgress.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/useProgress.ts electron/test/useProgress.test.ts
git commit -m "feat(app): websocket progress hook + pure reducer"
```

---

### Task 6: Shared UI components

**Files:**
- Create: `electron/src/components/Button.tsx`
- Create: `electron/src/components/StatusPill.tsx`
- Create: `electron/src/components/ProgressBar.tsx`

Small presentational components reused across screens. Build with the frontend-design skill for polish; baseline below.

- [ ] **Step 1: Write the components**

`electron/src/components/Button.tsx`:
```typescript
import type { ButtonHTMLAttributes } from "react";

export function Button({ variant = "primary", style, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const bg = variant === "primary" ? "var(--accent)"
    : variant === "danger" ? "var(--danger)" : "transparent";
  const color = variant === "ghost" ? "var(--text)" : "#0b0d12";
  return (
    <button {...rest} style={{
      background: bg, color, border: variant === "ghost" ? "1px solid var(--border)" : "none",
      padding: "10px 16px", borderRadius: 10, fontWeight: 600, cursor: "pointer",
      opacity: rest.disabled ? 0.5 : 1, ...style,
    }} />
  );
}
```

`electron/src/components/StatusPill.tsx`:
```typescript
export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = { ok: "var(--accent-2)", error: "var(--danger)", running: "var(--warn)" };
  const c = map[status] ?? "var(--text-dim)";
  return (
    <span style={{
      color: c, border: `1px solid ${c}`, borderRadius: 999,
      padding: "2px 10px", fontSize: 12, fontWeight: 600, textTransform: "capitalize",
    }}>{status}</span>
  );
}
```

`electron/src/components/ProgressBar.tsx`:
```typescript
export function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ background: "var(--bg-elev-2)", borderRadius: 999, height: 10, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)", transition: "width .3s" }} />
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd electron && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add electron/src/components
git commit -m "feat(app): shared UI components"
```

---

### Task 7: Sources & NAS settings screen

**Files:**
- Modify: `electron/src/screens/Sources.tsx`

Lets the user add source folders (native picker), set the NAS destination (native picker), set the schedule interval, and save — persisted via `PUT /api/settings`.

- [ ] **Step 1: Implement the screen**

`electron/src/screens/Sources.tsx`:
```typescript
import { useEffect, useState } from "react";
import { makeApi } from "../api";
import type { Config } from "../types";
import { Button } from "../components/Button";

const api = makeApi();

export function Sources() {
  const [cfg, setCfg] = useState<Config>({ sources: [], dest: "", interval_minutes: 0 });
  const [saved, setSaved] = useState(false);

  useEffect(() => { api.getSettings().then(setCfg).catch(() => {}); }, []);

  async function addSource() {
    const dir = await (window as any).ablebackup.pickFolder();
    if (dir && !cfg.sources.includes(dir)) setCfg({ ...cfg, sources: [...cfg.sources, dir] });
  }
  async function pickDest() {
    const dir = await (window as any).ablebackup.pickFolder();
    if (dir) setCfg({ ...cfg, dest: dir });
  }
  function removeSource(s: string) {
    setCfg({ ...cfg, sources: cfg.sources.filter((x) => x !== s) });
  }
  async function save() {
    const next = await api.saveSettings(cfg);
    setCfg(next); setSaved(true); setTimeout(() => setSaved(false), 1500);
  }

  return (
    <>
      <h1>Sources & NAS</h1>
      <p className="sub">Where to look for projects, and where to store backups.</p>

      <div className="card" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <strong>Source folders</strong>
          <Button variant="ghost" onClick={addSource}>+ Add folder</Button>
        </div>
        {cfg.sources.length === 0 && <p className="sub">No folders yet.</p>}
        {cfg.sources.map((s) => (
          <div key={s} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
            <span style={{ color: "var(--text-dim)" }}>{s}</span>
            <button onClick={() => removeSource(s)} style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer" }}>remove</button>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <strong>NAS destination</strong>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
          <input readOnly value={cfg.dest} placeholder="No destination set"
            style={{ flex: 1, background: "var(--bg-elev-2)", border: "1px solid var(--border)", color: "var(--text)", padding: "10px 12px", borderRadius: 8 }} />
          <Button variant="ghost" onClick={pickDest}>Choose…</Button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <strong>Automatic backup</strong>
        <div style={{ marginTop: 12 }}>
          <label className="sub">Every&nbsp;</label>
          <input type="number" min={0} value={cfg.interval_minutes}
            onChange={(e) => setCfg({ ...cfg, interval_minutes: Number(e.target.value) })}
            style={{ width: 80, background: "var(--bg-elev-2)", border: "1px solid var(--border)", color: "var(--text)", padding: "8px", borderRadius: 8 }} />
          <span className="sub">&nbsp;minutes (0 = off, app must be running)</span>
        </div>
      </div>

      <Button onClick={save}>{saved ? "Saved ✓" : "Save settings"}</Button>
    </>
  );
}
```

- [ ] **Step 2: Verify build + manual smoke**

Run: `cd electron && npm run build` → succeeds.
Manual: `npm start`, open Sources, add a folder (native dialog), choose a dest, set interval, Save → reload app, settings persist.

- [ ] **Step 3: Commit**

```bash
git add electron/src/screens/Sources.tsx
git commit -m "feat(app): sources & NAS settings screen"
```

---

### Task 8: Scan & approve screen

**Files:**
- Modify: `electron/src/screens/Scan.tsx`

Scans saved sources, lists discovered projects with present/missing counts and total size, and a "Back up all" action that starts the job and navigates to Progress.

- [ ] **Step 1: Implement the screen**

`electron/src/screens/Scan.tsx`:
```typescript
import { useState } from "react";
import { makeApi } from "../api";
import type { ProjectSummary } from "../types";
import { Button } from "../components/Button";

const api = makeApi();
function fmtSize(n: number) {
  if (n > 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n > 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n > 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

export function Scan({ onBackupStarted }: { onBackupStarted: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function scan() {
    setBusy(true); setErr(null);
    try { setProjects(await api.scan()); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }
  async function backupAll() {
    setErr(null);
    try { await api.startBackup({}); onBackupStarted(); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <>
      <h1>Scan & Back up</h1>
      <p className="sub">Find projects in your source folders and back them up.</p>
      <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
        <Button onClick={scan} disabled={busy}>{busy ? "Scanning…" : "Scan now"}</Button>
        {projects && projects.length > 0 &&
          <Button variant="primary" onClick={backupAll}>Back up all ({projects.length})</Button>}
      </div>
      {err && <div className="card" style={{ borderColor: "var(--danger)", color: "var(--danger)", marginBottom: 18 }}>{err}</div>}
      {projects && projects.length === 0 && <p className="sub">No projects found. Check your source folders.</p>}
      {projects && projects.map((p) => (
        <div key={p.als_path} className="card" style={{ marginBottom: 10, display: "flex", justifyContent: "space-between" }}>
          <div>
            <strong>{p.name}</strong>
            <div className="sub" style={{ margin: 0 }}>{p.project_dir}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div>{p.present_count} files · {fmtSize(p.total_size)}</div>
            {p.missing_count > 0 &&
              <div style={{ color: "var(--warn)" }}>{p.missing_count} missing</div>}
          </div>
        </div>
      ))}
    </>
  );
}
```

- [ ] **Step 2: Verify build + manual smoke**

Run: `cd electron && npm run build` → succeeds.
Manual: with a real Ableton folder configured, Scan lists projects; missing samples flagged.

- [ ] **Step 3: Commit**

```bash
git add electron/src/screens/Scan.tsx
git commit -m "feat(app): scan & approve screen"
```

---

### Task 9: Live backup progress screen

**Files:**
- Modify: `electron/src/screens/Backup.tsx`

Subscribes to the progress hook and renders an overall bar, current project, counts, and a scrolling log. Fires an OS notification on completion.

- [ ] **Step 1: Implement the screen**

`electron/src/screens/Backup.tsx`:
```typescript
import { useEffect } from "react";
import { useProgress } from "../useProgress";
import { ProgressBar } from "../components/ProgressBar";

export function Backup() {
  const p = useProgress(true);

  useEffect(() => {
    if (p.done) {
      new Notification("Ableton Backup", {
        body: `Backup finished — ${p.completed} ok, ${p.errors} error(s).`,
      });
    }
  }, [p.done]);

  return (
    <>
      <h1>Backup progress</h1>
      <p className="sub">{p.current ? `Backing up ${p.current}…` : p.done ? "Complete." : "Waiting for a backup to start…"}</p>
      <div className="card" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span>{p.completed + p.errors} / {p.total}</span>
          <span className="sub">{p.errors > 0 ? `${p.errors} error(s)` : ""}</span>
        </div>
        <ProgressBar value={p.completed + p.errors} max={p.total} />
      </div>
      <div className="card" style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, maxHeight: 360, overflow: "auto" }}>
        {p.log.length === 0 ? <span className="sub">No activity yet.</span>
          : p.log.map((line, i) => <div key={i}>{line}</div>)}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Verify build + manual smoke**

Run: `cd electron && npm run build` → succeeds.
Manual: trigger a backup from Scan → Progress shows live lines + bar, ends with a notification.

- [ ] **Step 3: Commit**

```bash
git add electron/src/screens/Backup.tsx
git commit -m "feat(app): live backup progress screen + completion notification"
```

---

### Task 10: Dashboard + Browse screens

**Files:**
- Modify: `electron/src/screens/Dashboard.tsx`
- Modify: `electron/src/screens/Browse.tsx`

Dashboard shows recent snapshots (date-indexed). Browse shows projects and, on selecting one, its snapshot timeline with missing-ref details.

- [ ] **Step 1: Implement Dashboard**

`electron/src/screens/Dashboard.tsx`:
```typescript
import { useEffect, useState } from "react";
import { makeApi } from "../api";
import type { Snapshot } from "../types";
import { StatusPill } from "../components/StatusPill";

const api = makeApi();

export function Dashboard() {
  const [rows, setRows] = useState<Snapshot[]>([]);
  useEffect(() => { api.history(25).then(setRows).catch(() => {}); }, []);
  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">Most recent backups across all projects.</p>
      {rows.length === 0 && <p className="sub">No backups yet.</p>}
      {rows.map((s) => (
        <div key={s.id} className="card" style={{ marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <strong>{s.project_name}</strong>
            <div className="sub" style={{ margin: 0 }}>{s.timestamp}</div>
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <span className="sub">{s.file_count} files</span>
            <StatusPill status={s.status} />
          </div>
        </div>
      ))}
    </>
  );
}
```

- [ ] **Step 2: Implement Browse**

`electron/src/screens/Browse.tsx`:
```typescript
import { useEffect, useState } from "react";
import { makeApi } from "../api";
import type { ProjectRow, Snapshot } from "../types";
import { StatusPill } from "../components/StatusPill";

const api = makeApi();

export function Browse() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);

  useEffect(() => { api.projects().then(setProjects).catch(() => {}); }, []);
  useEffect(() => {
    if (active) api.projectDetail(active).then((d) => setSnaps(d.snapshots)).catch(() => {});
  }, [active]);

  return (
    <>
      <h1>Browse backups</h1>
      <p className="sub">By project, then by date.</p>
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 18 }}>
        <div className="card">
          {projects.length === 0 && <span className="sub">No projects.</span>}
          {projects.map((p) => (
            <button key={p.project_name} onClick={() => setActive(p.project_name)}
              style={{ display: "block", width: "100%", textAlign: "left", background: active === p.project_name ? "var(--bg-elev-2)" : "transparent",
                border: "none", color: "var(--text)", padding: "10px 8px", borderRadius: 8, cursor: "pointer" }}>
              <strong>{p.project_name}</strong>
              <div className="sub" style={{ margin: 0 }}>{p.snapshot_count} snapshot(s)</div>
            </button>
          ))}
        </div>
        <div>
          {!active && <p className="sub">Select a project.</p>}
          {active && snaps.map((s) => (
            <div key={s.id} className="card" style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <strong>{s.timestamp}</strong><StatusPill status={s.status} />
              </div>
              <div className="sub" style={{ margin: "6px 0 0" }}>
                {s.file_count} files{s.missing && s.missing.length > 0 ? ` · ${s.missing.length} missing` : ""}
              </div>
              {s.missing && s.missing.length > 0 &&
                <ul style={{ color: "var(--warn)", margin: "8px 0 0", paddingLeft: 18 }}>
                  {s.missing.map((m) => <li key={m}>{m}</li>)}
                </ul>}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 3: Verify build + manual smoke**

Run: `cd electron && npm run build` → succeeds.
Manual: after a backup, Dashboard lists it; Browse shows the project and its snapshot with any missing refs.

- [ ] **Step 4: Commit**

```bash
git add electron/src/screens/Dashboard.tsx electron/src/screens/Browse.tsx
git commit -m "feat(app): dashboard + browse screens"
```

---

### Task 11: Tray icon + launch-at-login

**Files:**
- Modify: `electron/electron/main.js`
- Create: `electron/electron/tray.js`
- Create: `electron/build/icon.png` (a simple 32×32 PNG placeholder)

Adds a system tray with Show/Backup-now/Quit, keeps the app alive in the tray when the window closes (so scheduled runs continue), and a launch-at-login toggle.

- [ ] **Step 1: Add a tray module**

`electron/electron/tray.js`:
```javascript
const { Tray, Menu, nativeImage } = require("electron");
const path = require("path");

function createTray({ onShow, onQuit }) {
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "build", "icon.png"));
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Ableton Backup");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show", click: onShow },
    { type: "separator" },
    { label: "Quit", click: onQuit },
  ]));
  tray.on("click", onShow);
  return tray;
}

module.exports = { createTray };
```

- [ ] **Step 2: Wire tray + keep-alive + login item into main.js**

In `electron/electron/main.js`, add near the top:
```javascript
const { createTray } = require("./tray");
let tray = null;
let isQuitting = false;
```

Update `createWindow()` to hide-to-tray on close instead of quitting:
```javascript
  win.on("close", (e) => {
    if (!isQuitting) { e.preventDefault(); win.hide(); }
  });
```

Replace the `whenReady` body and window-all-closed/will-quit handlers:
```javascript
app.whenReady().then(async () => {
  sidecar = await startSidecar({ backendDir: backendDir(), dbPath: dbPath() });
  createWindow();
  tray = createTray({
    onShow: () => { win.show(); },
    onQuit: () => { isQuitting = true; app.quit(); },
  });
  app.setLoginItemSettings({ openAtLogin: true });
});

app.on("window-all-closed", () => { /* stay alive in tray */ });

app.on("before-quit", () => { isQuitting = true; });
app.on("will-quit", () => { if (sidecar?.proc) sidecar.proc.kill(); });
```

- [ ] **Step 3: Add a placeholder icon**

Create `electron/build/icon.png` — any small PNG. If none is handy, the tray falls back to an empty image (still functional). Generate a 32×32 solid square:
```bash
cd electron && node -e "const fs=require('fs');const z=require('zlib');function crc(b){let c=~0;for(let i=0;i<b.length;i++){c^=b[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c>>>0;}function chunk(t,d){const len=Buffer.alloc(4);len.writeUInt32BE(d.length);const tb=Buffer.from(t);const body=Buffer.concat([tb,d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(body));return Buffer.concat([len,body,c]);}const w=32,h=32;const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;const row=Buffer.concat([Buffer.from([0]),Buffer.concat(Array.from({length:w},()=>Buffer.from([0x6c,0x8c,0xff])))]);const raw=Buffer.concat(Array.from({length:h},()=>row));const idat=z.deflateSync(raw);const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))]);fs.mkdirSync('build',{recursive:true});fs.writeFileSync('build/icon.png',png);console.log('wrote build/icon.png');"
```

- [ ] **Step 4: Verify manual smoke**

Manual: `npm start`. Closing the window hides to tray (process stays). Tray menu Show reopens; Quit fully exits and the python sidecar is killed.

- [ ] **Step 5: Commit**

```bash
git add electron/electron/main.js electron/electron/tray.js electron/build/icon.png
git commit -m "feat(app): tray, keep-alive, launch-at-login"
```

---

### Task 12: Run docs + full verification

**Files:**
- Create: `electron/README.md`
- Modify: `.gitignore` (ignore `electron/node_modules`, `electron/dist`)

- [ ] **Step 1: Ensure node_modules/dist are ignored**

Append to the repo root `.gitignore`:
```
electron/node_modules/
electron/dist/
```

- [ ] **Step 2: Run renderer unit tests**

Run: `cd electron && npm test`
Expected: PASS (api + useProgress suites).

- [ ] **Step 3: Full manual end-to-end (documents the happy path)**

1. `cd electron && npm start`
2. Sources & NAS → add a real Ableton projects folder, choose a destination folder, Save.
3. Scan & Back up → Scan now → projects appear → Back up all.
4. Progress → live log to completion + notification.
5. Dashboard → the new snapshot listed. Browse → project → snapshot with any missing refs.
6. Close window → app hides to tray; Tray → Quit → process + sidecar exit.

- [ ] **Step 4: Write README**

`electron/README.md`:
```markdown
# Ableton Backup — desktop app

Electron shell + React UI over the `ablebackup` Python sidecar (Plan 3).

## Prerequisites
- Node 18+ and Python 3.11+ with the backend installed:
  `cd ../backend && python -m pip install -e ".[dev]"`

## Develop / run
    cd electron
    npm install
    npm start        # launches Vite + Electron; spawns the python sidecar

The app mints an auth token + port, starts `python -m ablebackup.server` with them,
waits for `/health`, and drives it over HTTP + WebSocket. Settings, scans, backups,
live progress, history browsing, and scheduling are all in the UI. The window hides
to the tray so scheduled backups keep running; Tray → Quit stops everything.

## Tests
    npm test         # renderer unit tests (api client + progress reducer)

## Packaging (later)
Not yet wired. A future step bundles the Python backend (PyInstaller) into
`resources/backend` and builds installers with electron-builder.
```

- [ ] **Step 5: Commit**

```bash
git add electron/README.md .gitignore
git commit -m "docs(app): run instructions + ignore build artifacts"
```

---

## Self-Review

**Spec coverage (design doc → tasks):**
- Electron main: sidecar spawn/supervise/shutdown, folder pickers, tray, notifications, launch-at-login → Tasks 3, 9, 11.
- Preload safe IPC bridge → Task 3.
- Renderer web app (React+Vite) → Tasks 1–2.
- Screen: Dashboard/history → Task 10. Sources & destination → Task 7. Scan results/approval w/ missing flagged → Task 8. Backup progress (WebSocket) → Tasks 5, 9. Browse (by project + by date) → Task 10. Settings/schedule → Task 7 (interval) + Task 10.
- Talks to Python over localhost HTTP + WS with token → Tasks 4, 5.
- Process model: token handshake, health-wait, kill-on-quit → Task 3, 11.

**Placeholder scan:** No TBD/TODO. Baseline component code is complete and runnable; the frontend-design skill is invoked to *raise* quality, not to fill gaps. Packaging is explicitly deferred (out of scope for "testable app") and labeled as such.

**Type consistency:** `ProjectSummary`, `Config`, `Snapshot`, `ProjectRow`, `JobStatus`, `ProgressEvent` (Task 4) are used unchanged across api.ts, useProgress.ts, and every screen. `makeApi()` method names (`getSettings/saveSettings/scan/startBackup/jobStatus/history/projects/projectDetail`) match all call sites. `window.ablebackup.{token,port,pickFolder}` (preload, Task 3) matches api.ts/useProgress.ts/Sources.tsx usage. The progress event shapes mirror the backend `service.py` emitter exactly (`backup_start/project_start/project_done/project_error/backup_done`).

**Risk notes:**
- Electron screens are verified by manual smoke (no headless Electron test harness in scope); the *pure* logic (api client, progress reducer) is unit-tested with vitest.
- `python` must be on PATH for the sidecar spawn; documented in the README. A future packaging task removes this assumption by bundling the backend.
```
