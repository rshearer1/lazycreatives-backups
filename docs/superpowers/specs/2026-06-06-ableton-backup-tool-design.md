# Ableton Project Backup Tool — Design

**Date:** 2026-06-06
**Status:** Approved design, ready for implementation planning

## Purpose

A cross-platform (Windows + Mac) desktop **backup tool for Ableton Live projects**. It scans
the user's machine for Ableton project files, resolves **every file each project depends on**
(including samples that live outside the project folder, so references never break), and copies
complete, self-contained copies of each project to a local NAS as **dated snapshots** with
content-level deduplication. It can run automatically on a schedule.

This is a **backup/archival tool**, not a live-sync tool. Stem export is explicitly out of scope
for v1 (see Non-Goals).

## Background / Decisions

The user's driver is **full control / own storage** (a local NAS), not reliance on a third-party
sync service. The tool must produce backups whose sample references stay intact — effectively
performing Ableton's "Collect All and Save" *externally*, by parsing the `.als` file rather than
opening Live.

Key decisions made during brainstorming:

| Decision | Choice |
|---|---|
| Primary goal | Access/backup project files anywhere (not stem export) |
| Devices | Windows + Mac machines that run Ableton |
| Destination | A local NAS, mounted by the user as a normal path |
| Versioning | Keep dated snapshots; dedup unchanged files |
| Discovery | Scan broadly, then user approves include/exclude |
| App shell | Electron + Python sidecar |
| Frontend | Web tech (React/HTML/CSS), to be polished later by Claude design |
| NAS layout | Primary by project→date, plus a date-indexed browse view in the UI |

## Architecture

```
┌─────────────────────────────────────────────┐
│  Electron app (the native window)             │
│  • Main process: spawns + supervises Python,  │
│    native menus, folder pickers, tray icon,   │
│    OS notifications, launch-at-login          │
│  • Renderer: web UI (React/HTML/CSS)          │
│         │  HTTP + WebSocket (localhost)       │
└─────────┼─────────────────────────────────────┘
          ▼
┌─────────────────────────────────────────────┐
│  Python sidecar (FastAPI) — the engine        │
│  • scanner       find .als in source folders  │
│  • als_parser    gunzip + XML → all file refs │
│  • resolver      build complete file set       │
│  • backup_engine snapshot + dedup → NAS        │
│  • catalog       SQLite: projects/history/hash │
│  • scheduler     automatic runs (APScheduler)  │
└─────────────────────────────────────────────┘
```

**Process model:** On launch, Electron spawns the Python sidecar as a child process bound to a
localhost port, passing a shared auth token. The renderer calls FastAPI endpoints and subscribes
to a WebSocket for live backup progress. Electron supervises the sidecar (restart on crash, kill
on quit). Native-only concerns (folder picker dialog, system tray, OS notifications,
launch-at-login) are handled by Electron; selected paths/values are passed to Python.

**Rationale:** the frontend stays pure web tech (looks identical on both OSes via bundled
Chromium, and is straightforward for Claude design to make fancy later), while all file/parsing/
backup logic lives in Python where it is easiest to write and test.

## Components

### Electron shell (`/electron`)
- **main process**: sidecar lifecycle (spawn/supervise/shutdown), `dialog.showOpenDialog` for
  picking source folders + NAS destination, `Tray`, `Notification`, launch-at-login, app menu.
- **preload**: safe IPC bridge exposing only the needed native calls to the renderer.
- **renderer**: hosts the web frontend; talks to the Python API over localhost.

### Frontend (`/frontend`)
Web app (React + Vite assumed; final styling done later by Claude design). Screens:
1. **Dashboard / history** — recent backups, status, totals, errors at a glance.
2. **Sources & destination** — configure folders to scan + the mounted NAS path.
3. **Scan results / approval** — list of discovered projects with per-project dependency summary
   (file count, total size, **missing references flagged**); include/exclude toggles.
4. **Backup progress** — live progress via WebSocket.
5. **Browse backups** — two views over the same data: by project→date, and date-indexed.
6. **Settings** — schedule, retention, dedup/hardlink status.

### Python sidecar (`/backend`)
- **api** — FastAPI routes + WebSocket progress channel; validates the auth token.
- **scanner** — walk configured source folders, find `.als`, collect metadata (path, project
  name, mtime, size). Skips Ableton's own backup folders by default.
- **als_parser** — gunzip the `.als`, parse XML, extract every `FileRef` (audio samples,
  recorded/frozen audio, video). Returns raw references with their path data and Live-version
  hints. **Highest-risk module → built test-first.**
- **resolver** — turn raw refs into absolute paths: resolve relative paths against the project
  folder, handle absolute paths, dedupe, check existence, classify inside-project vs external,
  flag missing.
- **backup_engine** — for an approved project, compute the complete file set, hash each file,
  dedup against the NAS content pool, write a dated snapshot as hardlinks into the pool (fallback
  to copies when hardlinks unsupported). Snapshots are atomic (write to temp, finalize last).
- **catalog** — SQLite database (see schema below).
- **scheduler** — APScheduler; re-runs the approved set on the configured schedule while the app
  (tray) is running.

## Data flow

1. App launches → Electron spawns Python sidecar → renderer connects.
2. User sets source folders + NAS path (native pickers in Electron → passed to backend).
3. **Scan**: backend walks sources, parses each `.als`, resolves deps, returns the project list
   with dependency summaries and missing-ref flags.
4. User approves a subset → triggers backup.
5. **Backup**: for each approved project, backend computes the file set, hashes files, dedups
   against the content pool, writes the dated snapshot, updates the catalog, streams progress
   over WebSocket.
6. **Schedule**: scheduler re-runs the approved set automatically while the app is running.

## NAS storage layout

```
<NAS>/AbletonBackups/
  _pool/<hash[:2]>/<hash>            # content-addressed store, each unique file once
  projects/<ProjectName>/<YYYY-MM-DD_HHMM>/   # snapshot = real project folder, files hardlinked to _pool
    <Project>.als
    Samples/...
    manifest.json                   # logical path → hash, sizes, source paths, missing refs
```

- **Primary layout** is `projects/<ProjectName>/<timestamp>/` — optimized for "give me the latest
  good version of this song."
- **Date-indexed view** is generated by the app UI from catalog data (no extra disk use), giving
  the literal "sorted by date" browse experience.
- **Dedup**: unchanged files across snapshots are hardlinks into `_pool`, so each snapshot is a
  full openable project but costs only the bytes of changed/new files. Falls back to plain copies
  when the destination filesystem doesn't support hardlinks (detected at runtime; surfaced in UI).

## Catalog schema (SQLite, local per machine)

- `projects(id, path, name, first_seen, last_backup_at, included)`
- `snapshots(id, project_id, timestamp, total_size, file_count, status, error)`
- `files(hash, size)` — content pool index
- `snapshot_files(snapshot_id, logical_path, hash, source_path)`
- `missing_refs(snapshot_id, project_id, expected_path)`
- `settings(key, value)` — source folders, NAS path, schedule, retention

## Error handling

- **Missing referenced files** → never fail the backup; record in `missing_refs` and report; back
  up everything that exists.
- **NAS unreachable** → skip with a clear error, retry on next run; surfaced in UI.
- **Locked / in-use `.als`** (Ableton open) → read-copy usually succeeds; on failure, skip with a
  warning rather than aborting the whole run.
- **Partial backup** → snapshots are atomic: write to a temp dir, write `manifest.json` last,
  rename into place only on success.
- **Permission errors** → reported per file; the rest of the project still backs up.

## Testing strategy

- **`als_parser`** (riskiest) — test-first against `.als` fixtures spanning multiple Live
  versions: relative paths, absolute paths, missing refs, "collected" vs scattered samples.
- **resolver** — path resolution + existence/classification against a temp fixture tree.
- **backup_engine** — dedup/hardlink behavior and snapshot atomicity in a temp dir; verify a
  second run of an unchanged project adds ~zero bytes.
- **Integration** — end-to-end scan → approve → backup → re-run-dedups against a temp "NAS" dir.
- **Cross-platform** — path handling (Windows backslash/drive letters vs `/Volumes` mounts);
  hardlink-support detection on the destination.

## Non-Goals (v1)

- **Stem export.** Ableton has no public API/SDK; Max for Live cannot trigger audio renders; the
  only true stems come from a human using File → Export Audio inside Live. A possible *future*
  extension is extracting raw per-track source audio from the `.als` (not a rendered mixdown).
- **Backing up plugins/VSTs.** These are installed software, not project files; a restored
  project still needs the same plugins installed. This is a fundamental limitation, documented to
  the user.
- **Backups while the app is closed.** Scheduled runs require the app/tray to be running
  (optionally launched at login).
- **Built-in SMB/NAS client.** The user mounts the NAS as a normal drive; the app takes a
  destination path.
- **Live sync / multi-device merge.** This is one-way archival backup only.
