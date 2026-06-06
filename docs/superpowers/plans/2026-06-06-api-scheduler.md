# Ableton Backup API + Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the tested `ablebackup` engine in a FastAPI localhost sidecar (HTTP + WebSocket progress) with persisted settings and an APScheduler-driven automatic backup run, so the future Electron renderer can drive scans/backups and receive live progress.

**Architecture:** A thin orchestration layer (`service.py`) extracts the scan/backup loop the CLI already has into reusable functions that accept a progress callback. The catalog gains a key/value `settings` table and history queries. A FastAPI app (`api/`) exposes auth-guarded endpoints over the service and streams progress through an asyncio `ProgressHub` to a WebSocket. A `BackupScheduler` (APScheduler) re-runs the saved config on an interval. A `server.py` entrypoint reads the auth token + port + db path from the environment and runs uvicorn.

**Tech Stack:** Python 3.11+, FastAPI + Starlette, uvicorn, APScheduler, the stdlib (`asyncio`, `sqlite3`, `json`), and `httpx` (Starlette `TestClient`) + `pytest` for tests. Async pub/sub is tested with `asyncio.run` (no `pytest-asyncio` dependency).

---

## File Structure

```
backend/
  pyproject.toml                 # MODIFY: add fastapi/uvicorn/apscheduler deps + httpx dev extra
  ablebackup/
    catalog.py                   # MODIFY: settings table + history queries
    service.py                   # NEW: scan() / run_backup() orchestration with progress callback
    cli.py                       # MODIFY: backup command calls service.run_backup (DRY)
    scheduler.py                 # NEW: BackupScheduler wrapping APScheduler
    server.py                    # NEW: uvicorn entrypoint (env-configured)
    api/
      __init__.py                # NEW
      progress.py                # NEW: ProgressHub async pub/sub with history replay
      auth.py                    # NEW: token dependency (header) + ws token check
      schemas.py                 # NEW: pydantic request/response models
      app.py                     # NEW: create_app() factory wiring everything
  tests/
    test_catalog_settings.py     # NEW
    test_catalog_history.py      # NEW
    test_service.py              # NEW
    test_progress.py             # NEW
    test_scheduler.py            # NEW
    test_api_auth.py             # NEW
    test_api_settings.py         # NEW
    test_api_scan_backup.py      # NEW
    test_api_history.py          # NEW
    test_api_ws_progress.py      # NEW
```

Each file has one responsibility: `service` orchestrates the engine, `catalog` persists, `progress` fans out events, `auth` guards, `schemas` types the wire format, `app` wires routes, `scheduler` automates, `server` boots.

---

### Task 1: Add server dependencies

**Files:**
- Modify: `backend/pyproject.toml`

- [ ] **Step 1: Update pyproject**

Replace `backend/pyproject.toml` with:
```toml
[project]
name = "ablebackup"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "defusedxml>=0.7",
    "fastapi>=0.110",
    "uvicorn>=0.27",
    "apscheduler>=3.10,<4",
]

[project.optional-dependencies]
dev = ["pytest>=8", "httpx>=0.27"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.pytest.ini_options]
pythonpath = ["."]
testpaths = ["tests"]
```

- [ ] **Step 2: Install**

Run: `cd backend && python -m pip install -e ".[dev]"`
Expected: installs fastapi, uvicorn, apscheduler, httpx, pytest.

- [ ] **Step 3: Verify existing suite still green**

Run: `cd backend && python -m pytest -q`
Expected: PASS (31 passed).

- [ ] **Step 4: Commit**

```bash
git add backend/pyproject.toml
git commit -m "chore: add fastapi/uvicorn/apscheduler/httpx deps"
```

---

### Task 2: Catalog — settings key/value store

**Files:**
- Modify: `backend/ablebackup/catalog.py`
- Test: `backend/tests/test_catalog_settings.py`

JSON-encoded values under string keys, so the API can persist the whole config (source folders list, dest path, schedule). One row per key, upserted.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_catalog_settings.py`:
```python
from ablebackup.catalog import Catalog


def test_set_get_setting_roundtrips_json(tmp_path):
    cat = Catalog(tmp_path / "c.db")
    cat.set_setting("config", {"sources": ["A", "B"], "dest": "Z:\\", "interval_minutes": 60})
    assert cat.get_setting("config") == {"sources": ["A", "B"], "dest": "Z:\\", "interval_minutes": 60}
    cat.close()


def test_get_setting_returns_default_when_absent(tmp_path):
    cat = Catalog(tmp_path / "c.db")
    assert cat.get_setting("missing", default={"x": 1}) == {"x": 1}
    assert cat.get_setting("missing") is None
    cat.close()


def test_set_setting_overwrites(tmp_path):
    cat = Catalog(tmp_path / "c.db")
    cat.set_setting("k", 1)
    cat.set_setting("k", 2)
    assert cat.get_setting("k") == 2
    cat.close()


def test_settings_persist_across_instances(tmp_path):
    db = tmp_path / "c.db"
    c1 = Catalog(db)
    c1.set_setting("config", {"sources": ["A"]})
    c1.close()
    c2 = Catalog(db)
    assert c2.get_setting("config") == {"sources": ["A"]}
    c2.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_catalog_settings.py -v`
Expected: FAIL — `AttributeError: 'Catalog' object has no attribute 'set_setting'`

- [ ] **Step 3: Write minimal implementation**

In `backend/ablebackup/catalog.py`, add `import json` at the top (below `import sqlite3`), add a `settings` table to `_SCHEMA`, and add two methods to `Catalog`.

Add to `_SCHEMA` (inside the triple-quoted string, after the `missing_refs` table):
```sql
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

Add methods to the `Catalog` class (after `missing_for`):
```python
    def set_setting(self, key, value) -> None:
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )
        self.conn.commit()

    def get_setting(self, key, default=None):
        row = self.conn.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ).fetchone()
        if row is None:
            return default
        return json.loads(row["value"])
```

Add the import near the top of the file:
```python
import json
import sqlite3
from pathlib import Path
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_catalog_settings.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/ablebackup/catalog.py backend/tests/test_catalog_settings.py
git commit -m "feat: add settings key/value store to catalog"
```

---

### Task 3: Catalog — history queries for browse views

**Files:**
- Modify: `backend/ablebackup/catalog.py`
- Test: `backend/tests/test_catalog_history.py`

The UI needs two browse views over the same data: recent snapshots (date-indexed) and a per-project list with totals. Both read from `snapshots`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_catalog_history.py`:
```python
from ablebackup.catalog import Catalog


def _seed(cat):
    cat.record_snapshot("Alpha", "2026-06-01_1000", 100, 5, "ok", [])
    cat.record_snapshot("Alpha", "2026-06-02_1000", 120, 6, "ok", ["x.wav"])
    cat.record_snapshot("Beta", "2026-06-03_1000", 50, 2, "error", [], error="NAS down")


def test_recent_snapshots_newest_first(tmp_path):
    cat = Catalog(tmp_path / "c.db")
    _seed(cat)
    rows = cat.recent_snapshots(limit=2)
    assert [r["timestamp"] for r in rows] == ["2026-06-03_1000", "2026-06-02_1000"]
    assert rows[0]["project_name"] == "Beta"
    assert rows[0]["status"] == "error"
    cat.close()


def test_projects_summary_aggregates(tmp_path):
    cat = Catalog(tmp_path / "c.db")
    _seed(cat)
    summary = cat.projects_summary()
    by_name = {p["project_name"]: p for p in summary}
    assert by_name["Alpha"]["snapshot_count"] == 2
    assert by_name["Alpha"]["last_timestamp"] == "2026-06-02_1000"
    assert by_name["Beta"]["snapshot_count"] == 1
    # alphabetical by project name
    assert [p["project_name"] for p in summary] == ["Alpha", "Beta"]
    cat.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_catalog_history.py -v`
Expected: FAIL — `AttributeError: 'Catalog' object has no attribute 'recent_snapshots'`

- [ ] **Step 3: Write minimal implementation**

Add to the `Catalog` class (after `get_setting`):
```python
    def recent_snapshots(self, limit=50) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM snapshots ORDER BY timestamp DESC, id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    def projects_summary(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT project_name, "
            "COUNT(*) AS snapshot_count, "
            "MAX(timestamp) AS last_timestamp, "
            "SUM(total_size) AS total_size "
            "FROM snapshots GROUP BY project_name ORDER BY project_name"
        ).fetchall()
        return [dict(r) for r in rows]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_catalog_history.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/ablebackup/catalog.py backend/tests/test_catalog_history.py
git commit -m "feat: add history/browse queries to catalog"
```

---

### Task 4: Service — scan and run_backup orchestration

**Files:**
- Create: `backend/ablebackup/service.py`
- Test: `backend/tests/test_service.py`

Extracts the per-project loop (with error isolation) the CLI already has into reusable functions. `scan_summary` returns JSON-serializable dicts. `run_backup` accepts an optional `progress` callback invoked with event dicts before/after each project, records each snapshot in the catalog, and returns a summary.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_service.py`:
```python
from pathlib import Path
from ablebackup.catalog import Catalog
from ablebackup.service import scan_summary, run_backup
from tests.helpers import write_als, fileref_rel


def _build_project(root: Path):
    proj = root / "Song Project"
    (proj / "Samples").mkdir(parents=True)
    (proj / "Samples" / "loop.wav").write_bytes(b"loopdata")
    write_als(proj / "Song.als", [fileref_rel("Samples/loop.wav", "loop.wav")])


def test_scan_summary_is_serializable(tmp_path):
    _build_project(tmp_path)
    projects = scan_summary([tmp_path])
    assert len(projects) == 1
    p = projects[0]
    assert p["name"] == "Song"
    assert p["present_count"] == 1
    assert p["missing_count"] == 0
    assert isinstance(p["project_dir"], str)
    assert isinstance(p["total_size"], int)


def test_run_backup_records_and_emits_progress(tmp_path):
    _build_project(tmp_path)
    dest = tmp_path / "NAS"
    cat = Catalog(tmp_path / "c.db")
    events = []

    summary = run_backup([tmp_path], dest, cat, timestamp="2026-06-06_1430",
                         progress=events.append)

    assert summary["ok_count"] == 1
    assert summary["error_count"] == 0
    assert (dest / "AbletonBackups" / "projects" / "Song" / "2026-06-06_1430" / "Song.als").exists()
    assert cat.snapshots_for("Song")[0]["file_count"] == 2
    types = [e["type"] for e in events]
    assert "project_start" in types
    assert "project_done" in types
    assert events[-1] == {"type": "backup_done", "ok_count": 1, "error_count": 1 - 1}
    cat.close()


def test_run_backup_isolates_project_errors(tmp_path, monkeypatch):
    _build_project(tmp_path)
    dest = tmp_path / "NAS"
    cat = Catalog(tmp_path / "c.db")

    import ablebackup.service as svc
    def boom(scan, dest_root, timestamp):
        raise OSError("disk full")
    monkeypatch.setattr(svc, "backup_project", boom)

    summary = run_backup([tmp_path], dest, cat, timestamp="t", progress=None)

    assert summary["ok_count"] == 0
    assert summary["error_count"] == 1
    row = cat.snapshots_for("Song")[0]
    assert row["status"] == "error"
    assert "disk full" in row["error"]
    cat.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_service.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ablebackup.service'`

- [ ] **Step 3: Write minimal implementation**

`backend/ablebackup/service.py`:
```python
"""Orchestration layer: reusable scan/backup over the engine, with progress events."""
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from ablebackup.backup_engine import backup_project
from ablebackup.catalog import Catalog
from ablebackup.scanner import scan_projects

ProgressCb = Optional[Callable[[dict], None]]


def default_timestamp() -> str:
    return datetime.now().strftime("%Y-%m-%d_%H%M")


def scan_summary(sources: list[Path]) -> list[dict]:
    """Scan sources and return JSON-serializable project summaries."""
    out = []
    for p in scan_projects([Path(s) for s in sources]):
        out.append({
            "name": p.name,
            "project_dir": str(p.project_dir),
            "als_path": str(p.als_path),
            "present_count": sum(1 for r in p.refs if r.exists),
            "missing_count": len(p.missing),
            "missing": [r.expected_path or r.name for r in p.missing],
            "total_size": p.total_size,
        })
    return out


def _emit(progress: ProgressCb, event: dict) -> None:
    if progress is not None:
        progress(event)


def run_backup(sources: list[Path], dest: Path, catalog: Catalog,
               timestamp: Optional[str] = None, progress: ProgressCb = None) -> dict:
    """Back up every discovered project to dest, recording history and emitting progress."""
    dest_root = Path(dest) / "AbletonBackups"
    timestamp = timestamp or default_timestamp()
    projects = scan_projects([Path(s) for s in sources])
    ok_count = 0
    error_count = 0
    _emit(progress, {"type": "backup_start", "project_count": len(projects),
                     "timestamp": timestamp})
    for i, p in enumerate(projects):
        _emit(progress, {"type": "project_start", "index": i,
                         "project_name": p.name, "total": len(projects)})
        try:
            result = backup_project(p, dest_root, timestamp)
        except Exception as e:  # isolate one project's failure from the rest
            catalog.record_snapshot(
                project_name=p.name, timestamp=timestamp, total_size=0,
                file_count=0, status="error", missing=[], error=str(e),
            )
            error_count += 1
            _emit(progress, {"type": "project_error", "index": i,
                             "project_name": p.name, "error": str(e)})
            continue
        catalog.record_snapshot(
            project_name=result.project_name, timestamp=result.timestamp,
            total_size=result.total_size, file_count=result.file_count,
            status="ok", missing=result.missing,
        )
        ok_count += 1
        _emit(progress, {"type": "project_done", "index": i,
                         "project_name": result.project_name,
                         "file_count": result.file_count,
                         "missing_count": len(result.missing)})
    _emit(progress, {"type": "backup_done", "ok_count": ok_count,
                     "error_count": error_count})
    return {"timestamp": timestamp, "ok_count": ok_count, "error_count": error_count}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_service.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/ablebackup/service.py backend/tests/test_service.py
git commit -m "feat: add scan/backup service layer with progress events"
```

---

### Task 5: CLI — reuse the service layer (DRY)

**Files:**
- Modify: `backend/ablebackup/cli.py`
- Test: `backend/tests/test_integration.py` (unchanged — must still pass)

The CLI's `_cmd_backup` duplicates the loop now living in `service.run_backup`. Replace the loop with a call to the service so there is one implementation.

- [ ] **Step 1: Confirm the existing integration test still describes desired behavior**

Run: `cd backend && python -m pytest tests/test_integration.py -v`
Expected: PASS (currently green; it is the regression guard for this refactor).

- [ ] **Step 2: Write minimal implementation**

Replace the body of `_cmd_backup` in `backend/ablebackup/cli.py` with a service call, and update imports. The full new `cli.py`:
```python
import argparse
from pathlib import Path

from ablebackup.catalog import Catalog
from ablebackup.scanner import scan_projects
from ablebackup.service import default_timestamp, run_backup


def _cmd_scan(args) -> int:
    projects = scan_projects([Path(s) for s in args.source])
    for p in projects:
        present = sum(1 for r in p.refs if r.exists)
        miss = len(p.missing)
        print(f"{p.name}: {present} files, {miss} missing  ({p.project_dir})")
    print(f"{len(projects)} project(s) found")
    return 0


def _cmd_backup(args) -> int:
    timestamp = args.timestamp or default_timestamp()
    cat = Catalog(Path(args.db))
    try:
        def progress(ev):
            if ev["type"] == "project_done":
                print(f"backed up {ev['project_name']}: "
                      f"{ev['file_count']} files, {ev['missing_count']} missing")
            elif ev["type"] == "project_error":
                print(f"ERROR backing up {ev['project_name']}: {ev['error']}")
        summary = run_backup([Path(s) for s in args.source], Path(args.dest),
                             cat, timestamp=timestamp, progress=progress)
    finally:
        cat.close()
    return 1 if summary["error_count"] else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ablebackup")
    sub = parser.add_subparsers(dest="command", required=True)

    scan_p = sub.add_parser("scan", help="list discovered projects")
    scan_p.add_argument("--source", action="append", required=True)
    scan_p.set_defaults(func=_cmd_scan)

    backup_p = sub.add_parser("backup", help="back up projects to destination")
    backup_p.add_argument("--source", action="append", required=True)
    backup_p.add_argument("--dest", required=True)
    backup_p.add_argument("--db", required=True)
    backup_p.add_argument("--timestamp", default=None)
    backup_p.set_defaults(func=_cmd_backup)

    return parser


def run(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    import sys
    raise SystemExit(run(sys.argv[1:]))
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_integration.py tests/test_service.py -v`
Expected: PASS (both)

- [ ] **Step 4: Commit**

```bash
git add backend/ablebackup/cli.py
git commit -m "refactor: CLI backup reuses service.run_backup (DRY)"
```

---

### Task 6: Progress hub — async pub/sub with history replay

**Files:**
- Create: `backend/ablebackup/api/__init__.py`
- Create: `backend/ablebackup/api/progress.py`
- Test: `backend/tests/test_progress.py`

Fans backup events out to any number of WebSocket subscribers. New subscribers first receive the buffered history (so a UI that connects mid-run still sees prior events), then live events. `publish_threadsafe` lets the backup thread feed the hub from outside the event loop.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_progress.py`:
```python
import asyncio
from ablebackup.api.progress import ProgressHub


def test_subscriber_receives_published_events():
    async def scenario():
        hub = ProgressHub()
        q = hub.subscribe()
        await hub.publish({"type": "a"})
        await hub.publish({"type": "b"})
        first = await asyncio.wait_for(q.get(), timeout=1)
        second = await asyncio.wait_for(q.get(), timeout=1)
        hub.unsubscribe(q)
        return first, second
    first, second = asyncio.run(scenario())
    assert first == {"type": "a"}
    assert second == {"type": "b"}


def test_new_subscriber_gets_history_first():
    async def scenario():
        hub = ProgressHub()
        await hub.publish({"type": "old1"})
        await hub.publish({"type": "old2"})
        q = hub.subscribe()  # subscribes AFTER events were published
        a = await asyncio.wait_for(q.get(), timeout=1)
        b = await asyncio.wait_for(q.get(), timeout=1)
        return a, b
    a, b = asyncio.run(scenario())
    assert a == {"type": "old1"}
    assert b == {"type": "old2"}


def test_multiple_subscribers_each_receive():
    async def scenario():
        hub = ProgressHub()
        q1 = hub.subscribe()
        q2 = hub.subscribe()
        await hub.publish({"type": "x"})
        return (await asyncio.wait_for(q1.get(), 1),
                await asyncio.wait_for(q2.get(), 1))
    r1, r2 = asyncio.run(scenario())
    assert r1 == {"type": "x"} == r2


def test_publish_threadsafe_delivers_to_loop():
    async def scenario():
        hub = ProgressHub()
        loop = asyncio.get_running_loop()
        hub.bind_loop(loop)
        q = hub.subscribe()
        # simulate a worker thread publishing
        await asyncio.to_thread(hub.publish_threadsafe, {"type": "from_thread"})
        return await asyncio.wait_for(q.get(), timeout=1)
    got = asyncio.run(scenario())
    assert got == {"type": "from_thread"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_progress.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ablebackup.api'`

- [ ] **Step 3: Write minimal implementation**

`backend/ablebackup/api/__init__.py`: (empty file)

`backend/ablebackup/api/progress.py`:
```python
"""Async pub/sub for streaming backup progress to WebSocket subscribers."""
import asyncio
from typing import Optional


class ProgressHub:
    def __init__(self, history_limit: int = 500):
        self._subscribers: list[asyncio.Queue] = []
        self._history: list[dict] = []
        self._history_limit = history_limit
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Record the event loop so worker threads can publish into it."""
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        for event in self._history:  # replay so late subscribers catch up
            q.put_nowait(event)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        if q in self._subscribers:
            self._subscribers.remove(q)

    async def publish(self, event: dict) -> None:
        self._record(event)
        for q in list(self._subscribers):
            q.put_nowait(event)

    def publish_threadsafe(self, event: dict) -> None:
        """Publish from a non-loop thread (the backup worker)."""
        if self._loop is None:
            raise RuntimeError("ProgressHub.bind_loop must be called first")
        asyncio.run_coroutine_threadsafe(self.publish(event), self._loop)

    def _record(self, event: dict) -> None:
        self._history.append(event)
        if len(self._history) > self._history_limit:
            self._history = self._history[-self._history_limit:]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_progress.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/ablebackup/api/__init__.py backend/ablebackup/api/progress.py backend/tests/test_progress.py
git commit -m "feat: add async progress hub with history replay"
```

---

### Task 7: Auth dependency + wire schemas

**Files:**
- Create: `backend/ablebackup/api/auth.py`
- Create: `backend/ablebackup/api/schemas.py`
- Test: covered by Task 8's `test_api_auth.py`

The sidecar binds to localhost but still requires a shared token (Electron passes it on spawn) so other local processes can't drive it. The token is checked from the `X-Auth-Token` header for HTTP and a `token` query param for WebSocket.

- [ ] **Step 1: Write minimal implementation (no separate test — exercised via the app in Task 8)**

`backend/ablebackup/api/auth.py`:
```python
"""Shared-token auth for the localhost sidecar."""
from fastapi import Header, HTTPException, Request, status


def require_token(request: Request, x_auth_token: str = Header(default="")) -> None:
    expected = request.app.state.token
    if not expected:  # token disabled (e.g. tests that opt out)
        return
    if x_auth_token != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="invalid or missing token")


def ws_token_ok(app, token: str) -> bool:
    expected = app.state.token
    return (not expected) or token == expected
```

`backend/ablebackup/api/schemas.py`:
```python
"""Pydantic wire models for the API."""
from pydantic import BaseModel


class Config(BaseModel):
    sources: list[str] = []
    dest: str = ""
    interval_minutes: int = 0  # 0 = scheduler disabled


class ScanRequest(BaseModel):
    sources: list[str] | None = None  # falls back to saved config when omitted


class BackupRequest(BaseModel):
    sources: list[str] | None = None
    dest: str | None = None
    timestamp: str | None = None
```

- [ ] **Step 2: Commit**

```bash
git add backend/ablebackup/api/auth.py backend/ablebackup/api/schemas.py
git commit -m "feat: add token auth dependency and API schemas"
```

---

### Task 8: App factory — health, auth, settings

**Files:**
- Create: `backend/ablebackup/api/app.py`
- Test: `backend/tests/test_api_auth.py`
- Test: `backend/tests/test_api_settings.py`

`create_app(token, db_path)` builds the FastAPI app, opens a `Catalog`, creates a `ProgressHub`, and binds the loop on startup. This task adds `GET /health` (no auth), and auth-guarded `GET/PUT /api/settings`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_api_auth.py`:
```python
from fastapi.testclient import TestClient
from ablebackup.api.app import create_app


def _client(tmp_path, token="secret"):
    app = create_app(token=token, db_path=tmp_path / "c.db")
    return TestClient(app)


def test_health_needs_no_token(tmp_path):
    c = _client(tmp_path)
    r = c.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_protected_route_rejects_missing_token(tmp_path):
    c = _client(tmp_path)
    r = c.get("/api/settings")
    assert r.status_code == 401


def test_protected_route_accepts_valid_token(tmp_path):
    c = _client(tmp_path)
    r = c.get("/api/settings", headers={"X-Auth-Token": "secret"})
    assert r.status_code == 200
```

`backend/tests/test_api_settings.py`:
```python
from fastapi.testclient import TestClient
from ablebackup.api.app import create_app


def _client(tmp_path):
    app = create_app(token="", db_path=tmp_path / "c.db")  # token="" disables auth for test
    return TestClient(app)


def test_settings_default_is_empty_config(tmp_path):
    c = _client(tmp_path)
    r = c.get("/api/settings")
    assert r.status_code == 200
    assert r.json() == {"sources": [], "dest": "", "interval_minutes": 0}


def test_put_settings_persists(tmp_path):
    c = _client(tmp_path)
    payload = {"sources": ["C:/Music"], "dest": "Z:/", "interval_minutes": 30}
    r = c.put("/api/settings", json=payload)
    assert r.status_code == 200
    assert c.get("/api/settings").json() == payload
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_auth.py tests/test_api_settings.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ablebackup.api.app'`

- [ ] **Step 3: Write minimal implementation**

`backend/ablebackup/api/app.py`:
```python
"""FastAPI application factory for the backup sidecar."""
import asyncio
from pathlib import Path

from fastapi import Depends, FastAPI

from ablebackup.api.auth import require_token
from ablebackup.api.progress import ProgressHub
from ablebackup.api.schemas import Config
from ablebackup.catalog import Catalog


def create_app(token: str, db_path: Path) -> FastAPI:
    app = FastAPI(title="ablebackup")
    app.state.token = token
    app.state.catalog = Catalog(Path(db_path))
    app.state.hub = ProgressHub()
    app.state.jobs = {}

    @app.on_event("startup")
    async def _bind_loop():
        app.state.hub.bind_loop(asyncio.get_running_loop())

    @app.on_event("shutdown")
    async def _close():
        app.state.catalog.close()

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/settings", dependencies=[Depends(require_token)])
    def get_settings() -> Config:
        saved = app.state.catalog.get_setting("config")
        return Config(**saved) if saved else Config()

    @app.put("/api/settings", dependencies=[Depends(require_token)])
    def put_settings(config: Config) -> Config:
        app.state.catalog.set_setting("config", config.model_dump())
        return config

    return app
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_auth.py tests/test_api_settings.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/ablebackup/api/app.py backend/tests/test_api_auth.py backend/tests/test_api_settings.py
git commit -m "feat: app factory with health, auth, settings endpoints"
```

---

### Task 9: Scan + backup endpoints (background job)

**Files:**
- Modify: `backend/ablebackup/api/app.py`
- Test: `backend/tests/test_api_scan_backup.py`

`POST /api/scan` runs synchronously (in the threadpool, since it is a `def` endpoint) and returns project summaries. `POST /api/backup` launches the backup on a background asyncio task that runs the blocking work in a thread, publishing progress to the hub; it returns a `job_id` immediately. `GET /api/jobs/{id}` reports job status so a caller can poll to completion.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_api_scan_backup.py`:
```python
import time
from pathlib import Path
from fastapi.testclient import TestClient
from ablebackup.api.app import create_app
from tests.helpers import write_als, fileref_rel


def _build_project(root: Path):
    proj = root / "Song Project"
    (proj / "Samples").mkdir(parents=True)
    (proj / "Samples" / "loop.wav").write_bytes(b"loopdata")
    write_als(proj / "Song.als", [fileref_rel("Samples/loop.wav", "loop.wav")])


def _client(tmp_path):
    app = create_app(token="", db_path=tmp_path / "c.db")
    return TestClient(app)


def test_scan_endpoint_returns_projects(tmp_path):
    src = tmp_path / "music"
    src.mkdir()
    _build_project(src)
    c = _client(tmp_path)
    r = c.post("/api/scan", json={"sources": [str(src)]})
    assert r.status_code == 200
    projects = r.json()["projects"]
    assert len(projects) == 1
    assert projects[0]["name"] == "Song"
    assert projects[0]["present_count"] == 1


def test_scan_uses_saved_config_when_sources_omitted(tmp_path):
    src = tmp_path / "music"
    src.mkdir()
    _build_project(src)
    c = _client(tmp_path)
    c.put("/api/settings", json={"sources": [str(src)], "dest": "", "interval_minutes": 0})
    r = c.post("/api/scan", json={})
    assert r.status_code == 200
    assert len(r.json()["projects"]) == 1


def test_backup_endpoint_runs_job_to_completion(tmp_path):
    src = tmp_path / "music"
    src.mkdir()
    _build_project(src)
    dest = tmp_path / "NAS"
    c = _client(tmp_path)
    r = c.post("/api/backup", json={"sources": [str(src)], "dest": str(dest),
                                    "timestamp": "2026-06-06_1430"})
    assert r.status_code == 200
    job_id = r.json()["job_id"]

    # poll until the background job finishes
    for _ in range(100):
        status = c.get(f"/api/jobs/{job_id}").json()
        if status["state"] == "done":
            break
        time.sleep(0.05)
    assert status["state"] == "done"
    assert status["result"]["ok_count"] == 1
    snap = dest / "AbletonBackups" / "projects" / "Song" / "2026-06-06_1430" / "Song.als"
    assert snap.exists()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_scan_backup.py -v`
Expected: FAIL — 404 / `KeyError` (endpoints not defined yet).

- [ ] **Step 3: Write minimal implementation**

Add imports at the top of `backend/ablebackup/api/app.py`:
```python
import asyncio
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException

from ablebackup.api.auth import require_token
from ablebackup.api.progress import ProgressHub
from ablebackup.api.schemas import BackupRequest, Config, ScanRequest
from ablebackup.catalog import Catalog
from ablebackup.service import default_timestamp, run_backup, scan_summary
```

Add these endpoints inside `create_app`, before `return app`:
```python
    def _resolve_sources(supplied):
        if supplied:
            return [Path(s) for s in supplied]
        saved = app.state.catalog.get_setting("config") or {}
        return [Path(s) for s in saved.get("sources", [])]

    @app.post("/api/scan", dependencies=[Depends(require_token)])
    def scan(req: ScanRequest):
        sources = _resolve_sources(req.sources)
        return {"projects": scan_summary(sources)}

    async def _run_job(job_id, sources, dest, timestamp):
        hub = app.state.hub
        cat = app.state.catalog
        def progress(ev):
            hub.publish_threadsafe(ev)
        try:
            result = await asyncio.to_thread(
                run_backup, sources, dest, cat, timestamp, progress)
            app.state.jobs[job_id] = {"state": "done", "result": result}
        except Exception as e:  # pragma: no cover - defensive
            app.state.jobs[job_id] = {"state": "error", "error": str(e)}

    @app.post("/api/backup", dependencies=[Depends(require_token)])
    def backup(req: BackupRequest):
        sources = _resolve_sources(req.sources)
        saved = app.state.catalog.get_setting("config") or {}
        dest = req.dest or saved.get("dest", "")
        if not dest:
            raise HTTPException(status_code=400, detail="no destination configured")
        timestamp = req.timestamp or default_timestamp()
        job_id = uuid.uuid4().hex
        app.state.jobs[job_id] = {"state": "running"}
        asyncio.create_task(_run_job(job_id, sources, Path(dest), timestamp))
        return {"job_id": job_id, "state": "running"}

    @app.get("/api/jobs/{job_id}", dependencies=[Depends(require_token)])
    def job_status(job_id: str):
        job = app.state.jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="unknown job")
        return job
```

Remove the now-duplicate `import asyncio` / `from pathlib import Path` / `from fastapi import ...` lines that existed from Task 8 (the import block above is the complete replacement for the top of the file).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_api_scan_backup.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/ablebackup/api/app.py backend/tests/test_api_scan_backup.py
git commit -m "feat: scan + background backup job endpoints"
```

---

### Task 10: History/browse endpoints

**Files:**
- Modify: `backend/ablebackup/api/app.py`
- Test: `backend/tests/test_api_history.py`

`GET /api/history` returns recent snapshots (date-indexed view). `GET /api/projects` returns the per-project summary. `GET /api/projects/{name}` returns that project's snapshots with their missing refs.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_api_history.py`:
```python
from fastapi.testclient import TestClient
from ablebackup.api.app import create_app


def _client(tmp_path):
    app = create_app(token="", db_path=tmp_path / "c.db")
    c = TestClient(app)
    cat = app.state.catalog
    cat.record_snapshot("Alpha", "2026-06-01_1000", 100, 5, "ok", [])
    cat.record_snapshot("Alpha", "2026-06-02_1000", 120, 6, "ok", ["x.wav"])
    cat.record_snapshot("Beta", "2026-06-03_1000", 50, 2, "ok", [])
    return c


def test_history_returns_recent_newest_first(tmp_path):
    c = _client(tmp_path)
    rows = c.get("/api/history").json()["snapshots"]
    assert rows[0]["project_name"] == "Beta"
    assert rows[0]["timestamp"] == "2026-06-03_1000"


def test_projects_summary_endpoint(tmp_path):
    c = _client(tmp_path)
    projects = c.get("/api/projects").json()["projects"]
    by = {p["project_name"]: p for p in projects}
    assert by["Alpha"]["snapshot_count"] == 2


def test_project_detail_includes_missing(tmp_path):
    c = _client(tmp_path)
    detail = c.get("/api/projects/Alpha").json()
    assert len(detail["snapshots"]) == 2
    second = [s for s in detail["snapshots"] if s["timestamp"] == "2026-06-02_1000"][0]
    assert second["missing"] == ["x.wav"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_history.py -v`
Expected: FAIL — 404 (endpoints not defined).

- [ ] **Step 3: Write minimal implementation**

Add inside `create_app`, before `return app`:
```python
    @app.get("/api/history", dependencies=[Depends(require_token)])
    def history(limit: int = 50):
        return {"snapshots": app.state.catalog.recent_snapshots(limit=limit)}

    @app.get("/api/projects", dependencies=[Depends(require_token)])
    def projects():
        return {"projects": app.state.catalog.projects_summary()}

    @app.get("/api/projects/{name}", dependencies=[Depends(require_token)])
    def project_detail(name: str):
        cat = app.state.catalog
        snaps = cat.snapshots_for(name)
        for s in snaps:
            s["missing"] = cat.missing_for(s["id"])
        return {"project_name": name, "snapshots": snaps}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_api_history.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/ablebackup/api/app.py backend/tests/test_api_history.py
git commit -m "feat: history and project browse endpoints"
```

---

### Task 11: WebSocket progress endpoint

**Files:**
- Modify: `backend/ablebackup/api/app.py`
- Test: `backend/tests/test_api_ws_progress.py`

`WS /ws/progress?token=...` subscribes to the hub and forwards every event as JSON. A client that connects, then triggers a backup, receives the `backup_start … backup_done` stream.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_api_ws_progress.py`:
```python
from pathlib import Path
from fastapi.testclient import TestClient
from ablebackup.api.app import create_app
from tests.helpers import write_als, fileref_rel


def _build_project(root: Path):
    proj = root / "Song Project"
    (proj / "Samples").mkdir(parents=True)
    (proj / "Samples" / "loop.wav").write_bytes(b"loopdata")
    write_als(proj / "Song.als", [fileref_rel("Samples/loop.wav", "loop.wav")])


def test_ws_streams_backup_progress(tmp_path):
    src = tmp_path / "music"
    src.mkdir()
    _build_project(src)
    dest = tmp_path / "NAS"
    app = create_app(token="", db_path=tmp_path / "c.db")
    client = TestClient(app)

    with client.websocket_connect("/ws/progress") as ws:
        client.post("/api/backup", json={"sources": [str(src)], "dest": str(dest),
                                         "timestamp": "2026-06-06_1430"})
        seen = []
        for _ in range(50):
            ev = ws.receive_json()
            seen.append(ev["type"])
            if ev["type"] == "backup_done":
                break
    assert "backup_start" in seen
    assert "project_done" in seen
    assert seen[-1] == "backup_done"


def test_ws_rejects_bad_token(tmp_path):
    app = create_app(token="secret", db_path=tmp_path / "c.db")
    client = TestClient(app)
    import pytest
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/progress?token=wrong") as ws:
            ws.receive_json()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_ws_progress.py -v`
Expected: FAIL — connection rejected / 404 (no ws route).

- [ ] **Step 3: Write minimal implementation**

Add `WebSocket` and `WebSocketDisconnect` to the FastAPI import in `app.py`:
```python
from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
```

Add the `ws_token_ok` import:
```python
from ablebackup.api.auth import require_token, ws_token_ok
```

Add inside `create_app`, before `return app`:
```python
    @app.websocket("/ws/progress")
    async def ws_progress(websocket: WebSocket, token: str = ""):
        if not ws_token_ok(app, token):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        q = app.state.hub.subscribe()
        try:
            while True:
                event = await q.get()
                await websocket.send_json(event)
        except WebSocketDisconnect:
            pass
        finally:
            app.state.hub.unsubscribe(q)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_api_ws_progress.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/ablebackup/api/app.py backend/tests/test_api_ws_progress.py
git commit -m "feat: websocket progress endpoint"
```

---

### Task 12: Scheduler — automatic backup runs

**Files:**
- Create: `backend/ablebackup/scheduler.py`
- Test: `backend/tests/test_scheduler.py`

Wraps APScheduler's `BackgroundScheduler`. `set_interval(minutes)` (re)registers a single job that runs `run_backup` with the saved config; `0` disables it. The job function is exposed as `_run_once` so tests can invoke it directly without waiting on the clock.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_scheduler.py`:
```python
from pathlib import Path
from ablebackup.catalog import Catalog
from ablebackup.scheduler import BackupScheduler
from tests.helpers import write_als, fileref_rel


def _build_project(root: Path):
    proj = root / "Song Project"
    (proj / "Samples").mkdir(parents=True)
    (proj / "Samples" / "loop.wav").write_bytes(b"loopdata")
    write_als(proj / "Song.als", [fileref_rel("Samples/loop.wav", "loop.wav")])


def test_set_interval_registers_and_clears_job(tmp_path):
    cat = Catalog(tmp_path / "c.db")
    sched = BackupScheduler(cat)
    assert sched.job_count() == 0
    sched.set_interval(30)
    assert sched.job_count() == 1
    sched.set_interval(45)  # replaces, not adds
    assert sched.job_count() == 1
    sched.set_interval(0)   # disables
    assert sched.job_count() == 0
    sched.shutdown()


def test_run_once_backs_up_saved_config(tmp_path):
    src = tmp_path / "music"
    src.mkdir()
    _build_project(src)
    dest = tmp_path / "NAS"
    cat = Catalog(tmp_path / "c.db")
    cat.set_setting("config", {"sources": [str(src)], "dest": str(dest),
                               "interval_minutes": 30})
    sched = BackupScheduler(cat)

    sched._run_once()

    assert len(cat.snapshots_for("Song")) == 1
    assert (dest / "AbletonBackups" / "projects" / "Song").exists()
    sched.shutdown()


def test_run_once_noop_without_config(tmp_path):
    cat = Catalog(tmp_path / "c.db")
    sched = BackupScheduler(cat)
    sched._run_once()  # must not raise when sources/dest unset
    sched.shutdown()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_scheduler.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ablebackup.scheduler'`

- [ ] **Step 3: Write minimal implementation**

`backend/ablebackup/scheduler.py`:
```python
"""APScheduler-backed automatic backup runner."""
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler

from ablebackup.catalog import Catalog
from ablebackup.service import run_backup

_JOB_ID = "auto_backup"


class BackupScheduler:
    def __init__(self, catalog: Catalog):
        self._catalog = catalog
        self._scheduler = BackgroundScheduler()
        self._scheduler.start(paused=False)

    def set_interval(self, minutes: int) -> None:
        existing = self._scheduler.get_job(_JOB_ID)
        if existing is not None:
            existing.remove()
        if minutes and minutes > 0:
            self._scheduler.add_job(
                self._run_once, "interval", minutes=minutes, id=_JOB_ID,
            )

    def job_count(self) -> int:
        return len(self._scheduler.get_jobs())

    def _run_once(self) -> None:
        config = self._catalog.get_setting("config") or {}
        sources = config.get("sources", [])
        dest = config.get("dest", "")
        if not sources or not dest:
            return  # nothing configured yet
        run_backup([Path(s) for s in sources], Path(dest), self._catalog)

    def shutdown(self) -> None:
        self._scheduler.shutdown(wait=False)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_scheduler.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/ablebackup/scheduler.py backend/tests/test_scheduler.py
git commit -m "feat: APScheduler-backed automatic backup runs"
```

---

### Task 13: Wire scheduler into the app + schedule endpoint

**Files:**
- Modify: `backend/ablebackup/api/app.py`
- Test: `backend/tests/test_api_settings.py` (extend)

The app owns a `BackupScheduler`; saving settings with `interval_minutes` (re)configures it, and the scheduler is reapplied from saved config on startup and torn down on shutdown.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_api_settings.py`:
```python
def test_put_settings_configures_scheduler(tmp_path):
    from ablebackup.api.app import create_app
    app = create_app(token="", db_path=tmp_path / "c.db")
    c = TestClient(app)
    with c:  # triggers startup/shutdown events
        c.put("/api/settings", json={"sources": ["X"], "dest": "Z:/",
                                     "interval_minutes": 15})
        assert app.state.scheduler.job_count() == 1
        c.put("/api/settings", json={"sources": ["X"], "dest": "Z:/",
                                     "interval_minutes": 0})
        assert app.state.scheduler.job_count() == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_settings.py::test_put_settings_configures_scheduler -v`
Expected: FAIL — `AttributeError: 'State' object has no attribute 'scheduler'`

- [ ] **Step 3: Write minimal implementation**

In `backend/ablebackup/api/app.py`, import the scheduler:
```python
from ablebackup.scheduler import BackupScheduler
```

In `create_app`, after `app.state.jobs = {}`:
```python
    app.state.scheduler = BackupScheduler(app.state.catalog)
```

Replace the startup handler to also apply the saved interval:
```python
    @app.on_event("startup")
    async def _on_start():
        app.state.hub.bind_loop(asyncio.get_running_loop())
        saved = app.state.catalog.get_setting("config") or {}
        app.state.scheduler.set_interval(saved.get("interval_minutes", 0))
```

Replace the shutdown handler:
```python
    @app.on_event("shutdown")
    async def _on_stop():
        app.state.scheduler.shutdown()
        app.state.catalog.close()
```

Update `put_settings` to reconfigure the scheduler:
```python
    @app.put("/api/settings", dependencies=[Depends(require_token)])
    def put_settings(config: Config) -> Config:
        app.state.catalog.set_setting("config", config.model_dump())
        app.state.scheduler.set_interval(config.interval_minutes)
        return config
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_api_settings.py -v`
Expected: PASS (all settings tests)

- [ ] **Step 5: Commit**

```bash
git add backend/ablebackup/api/app.py backend/tests/test_api_settings.py
git commit -m "feat: wire scheduler into app + settings-driven interval"
```

---

### Task 14: Server entrypoint

**Files:**
- Create: `backend/ablebackup/server.py`
- Test: `backend/tests/test_server.py`

Reads the auth token, port, and db path from the environment (Electron sets these on spawn) and runs uvicorn. The factory and config-reading are tested without actually binding a socket.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_server.py`:
```python
from ablebackup.server import build_app_from_env, read_config


def test_read_config_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("ABLEBACKUP_TOKEN", "tok")
    monkeypatch.setenv("ABLEBACKUP_PORT", "8123")
    monkeypatch.setenv("ABLEBACKUP_DB", str(tmp_path / "c.db"))
    cfg = read_config()
    assert cfg["token"] == "tok"
    assert cfg["port"] == 8123
    assert cfg["db_path"] == str(tmp_path / "c.db")


def test_read_config_defaults(monkeypatch):
    monkeypatch.delenv("ABLEBACKUP_TOKEN", raising=False)
    monkeypatch.delenv("ABLEBACKUP_PORT", raising=False)
    monkeypatch.delenv("ABLEBACKUP_DB", raising=False)
    cfg = read_config()
    assert cfg["token"] == ""
    assert cfg["port"] == 8753
    assert cfg["db_path"].endswith("catalog.db")


def test_build_app_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("ABLEBACKUP_TOKEN", "tok")
    monkeypatch.setenv("ABLEBACKUP_DB", str(tmp_path / "c.db"))
    app = build_app_from_env()
    assert app.state.token == "tok"
    app.state.catalog.close()
    app.state.scheduler.shutdown()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_server.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ablebackup.server'`

- [ ] **Step 3: Write minimal implementation**

`backend/ablebackup/server.py`:
```python
"""Uvicorn entrypoint for the backup sidecar (configured via environment)."""
import os
from pathlib import Path

from ablebackup.api.app import create_app

_DEFAULT_PORT = 8753


def _default_db_path() -> str:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".ablebackup")
    return str(Path(base) / "ablebackup" / "catalog.db")


def read_config() -> dict:
    return {
        "token": os.environ.get("ABLEBACKUP_TOKEN", ""),
        "port": int(os.environ.get("ABLEBACKUP_PORT", _DEFAULT_PORT)),
        "db_path": os.environ.get("ABLEBACKUP_DB", _default_db_path()),
    }


def build_app_from_env():
    cfg = read_config()
    return create_app(token=cfg["token"], db_path=Path(cfg["db_path"]))


def main() -> None:  # pragma: no cover - exercised manually / by Electron
    import uvicorn
    cfg = read_config()
    app = create_app(token=cfg["token"], db_path=Path(cfg["db_path"]))
    uvicorn.run(app, host="127.0.0.1", port=cfg["port"])


if __name__ == "__main__":  # pragma: no cover
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_server.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/ablebackup/server.py backend/tests/test_server.py
git commit -m "feat: env-configured uvicorn server entrypoint"
```

---

### Task 15: Full suite + README update

**Files:**
- Modify: `backend/README.md`
- Test: (whole suite)

- [ ] **Step 1: Run the full suite**

Run: `cd backend && python -m pytest -q`
Expected: PASS — all engine + API + scheduler tests.

- [ ] **Step 2: Manual smoke (optional, documents real run)**

Run (PowerShell):
```powershell
$env:ABLEBACKUP_TOKEN="dev"; python -m ablebackup.server
```
Then in another shell: `curl http://127.0.0.1:8753/health` → `{"status":"ok"}`. Ctrl-C to stop.

- [ ] **Step 3: Append the API section to `backend/README.md`**

Add to `backend/README.md`:
```markdown

## API sidecar (Plan 2)

Run the localhost engine server (the future Electron app spawns this):

    $env:ABLEBACKUP_TOKEN="<shared-token>"   # PowerShell; omit to disable auth
    python -m ablebackup.server               # binds 127.0.0.1:8753

Endpoints (all under `/api` require header `X-Auth-Token: <token>`):

- `GET  /health` — liveness, no auth
- `GET/PUT /api/settings` — persisted config: `sources[]`, `dest`, `interval_minutes`
- `POST /api/scan` — `{sources?}` → discovered projects with present/missing counts
- `POST /api/backup` — `{sources?, dest?, timestamp?}` → `{job_id}`; runs in background
- `GET  /api/jobs/{id}` — poll backup job state/result
- `GET  /api/history` — recent snapshots (date-indexed view)
- `GET  /api/projects`, `GET /api/projects/{name}` — per-project browse
- `WS   /ws/progress?token=<token>` — live backup progress events

Setting `interval_minutes > 0` enables an APScheduler job that re-runs the saved
config automatically while the server is running.

Next plan: the Electron shell + web UI that drives these endpoints.
```

- [ ] **Step 4: Commit**

```bash
git add backend/README.md
git commit -m "docs: document API sidecar + scheduler"
```

---

## Self-Review

**Spec coverage:**
- FastAPI routes + WebSocket progress + auth token → Tasks 7–11.
- Scanner/parser/resolver/backup engine reuse → service layer (Task 4) wraps the existing tested engine; no engine rewrite.
- Settings persistence (source folders, NAS path, schedule) → Tasks 2, 8, 13.
- Scheduler (APScheduler), re-runs approved set while app runs → Tasks 12–13.
- Dashboard/history + browse-by-project + date-indexed views → Tasks 3, 10 (data endpoints; visual UI is Plan 3).
- Backup progress streamed live → Tasks 6, 9, 11.
- Error handling (missing refs non-fatal, per-project isolation, NAS errors surfaced) → service layer (Task 4) + job/error states (Task 9).
- Native concerns (folder pickers, tray, notifications, launch-at-login) → explicitly Plan 3 (Electron).

**Placeholder scan:** No TBD/TODO. `# pragma: no cover` markers are intentional (uvicorn `main`, defensive job-error branch) and carry full code, not stubs.

**Type consistency:** `Config(sources, dest, interval_minutes)`, `ScanRequest(sources)`, `BackupRequest(sources, dest, timestamp)` used consistently across Tasks 7–13. `Catalog.set_setting/get_setting/recent_snapshots/projects_summary` (Tasks 2–3) match their call sites (Tasks 8, 10, 12, 13). `scan_summary`/`run_backup` signatures (Task 4) match CLI (Task 5), app (Task 9), and scheduler (Task 12). `ProgressHub.subscribe/unsubscribe/publish/publish_threadsafe/bind_loop` (Task 6) match app usage (Tasks 8, 9, 11). `BackupScheduler.set_interval/job_count/_run_once/shutdown` (Task 12) match app wiring (Task 13).

**FastAPI version note:** `@app.on_event("startup"/"shutdown")` is used for broad compatibility. If the installed FastAPI emits deprecation warnings, they are non-fatal; a lifespan-handler migration can be a later cleanup.
```
