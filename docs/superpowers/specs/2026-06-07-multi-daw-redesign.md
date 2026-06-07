I now have full grounding across the format seams, the engine, the catalog migration pattern, the wire contract, and the renderer. Writing the brief.

---

# Redesign Brief — From Ableton-only to a Multi-DAW, Flow-First Backup Tool

This brief synthesizes five design explorations into one plan. It is grounded in the real code: the entire dedup/verify/catalog/resolver/locator pipeline is already DAW-agnostic, and Ableton-specific knowledge lives in exactly **two functions** — `als_parser.parse_als()` and `scanner.find_als()` — plus a handful of cosmetic literals (`als_path`, `"AbletonBackups"`, the `*.als` glob in `verifier.py`). That is the whole reason this is a sequence of small shippable changes, not a rewrite.

---

## 1. Vision

The product becomes a **content-verified, deduplicated project archiver for any DAW**: you point it at your project folders, it finds every session regardless of DAW, follows each session's sample references, snapshots them deduplicated and hardlinked to your own NAS/drive, then **re-reads and re-hashes every file to prove the backup actually opens**. The differentiators — *your samples never go missing* (resolver + library relink), *proven restores* (re-hash verify), *space saved* (dedup pool), *you own the storage* (local, no cloud, no account) — are exactly the claims cloud DAW-sync tools structurally cannot make. Ableton is just the first adapter; FL Studio is next; Reaper/Logic/Studio One/Bitwig/Cubase are future adapter modules.

**Name recommendation:** lead with **Sessionsafe** — "session/project/track" is vocabulary every DAW shares (Ableton "Set", FL "project", Pro Tools "session"), and "safe" sells the verified/owned-storage story. Alternates: **Trackvault**, **Projectkeep**. (All need a domain/trademark/handle check before commit.) Tagline: *"Verified backups for every project — Ableton, FL Studio, and more."* Note there is **no shipped installer / electron-builder appId yet**, so the bundle id (e.g. `com.sessionsafe.app`) is a clean-slate choice with zero installed-base migration.

---

## 2. Multi-DAW architecture

**One seam, one registry.** Introduce a `DawAdapter` Protocol and an extension-keyed registry. `scanner` and `verifier` consult the registry instead of importing `parse_als` directly. Everything else (`resolver`, `backup_engine`, `locator`, `catalog`, `service`, `scheduler`, the whole API + `/ws/progress`) is reused **unchanged in logic** because it already speaks the neutral `FileRef` / `ResolvedRef` / `ProjectScan` models.

```python
# backend/ablebackup/daws/base.py
from typing import Protocol, Iterable
from pathlib import Path
from ablebackup.models import FileRef

class DawAdapter(Protocol):
    daw_id: str                      # 'ableton' | 'flstudio'  (stored in manifest + catalog)
    display_name: str                # 'Ableton Live' | 'FL Studio'
    extensions: tuple[str, ...]      # ('.als',)  — drives discovery AND dispatch

    def discover_projects(self, roots: list[Path]) -> Iterable[Path]: ...
    def parse_project(self, project_path: Path) -> list[FileRef]: ...   # replaces parse_als verbatim
    def project_name(self, p: Path) -> str: ...      # default: p.stem
    def skip_dirs(self) -> set[str]: ...             # default {'Backup'} + dest-root name
    def default_libraries(self) -> list[Path]: ...   # Ableton -> ~/Splice; others own/empty
```

```python
# backend/ablebackup/daws/registry.py
DAW_REGISTRY = [AbletonAdapter(), FlStudioAdapter()]
_BY_EXT = {ext: a for a in DAW_REGISTRY for ext in a.extensions}

def adapter_for_path(p: Path):   return _BY_EXT.get(p.suffix.lower())
def adapter_for_id(daw_id: str): return next(a for a in DAW_REGISTRY if a.daw_id == daw_id)
def all_extensions() -> set[str]: return set(_BY_EXT)
```

**What moves behind it:** `als_parser.parse_als` → `AbletonAdapter.parse_project` (verbatim — `FileRef`, the `SampleRef`/`OriginalFileSize`/`_VIDEO_EXTS`/factory-preset filtering is all Ableton-specific and stays inside that adapter). `find_als`'s extension match and `SKIP_DIRS` become registry-driven. `locator.default_libraries`' hardcoded `~/Splice` moves to `AbletonAdapter.default_libraries()`.

**What's reused unchanged:** `hashing.py`, `resolver.py` (operates purely on `FileRef`/`ResolvedRef`; `_candidates` already handles `absolute_path`, and `_match_located` already tolerates `size==0` via its path-tail-score≥2 fallback — which matters because non-Ableton DAWs rarely record a size), `backup_engine.py` (pool/hardlink/atomic-rename/`.abid` claim/manifest), `catalog.py` queries, `scheduler.py`, `api/progress.py`, `api/auth.py`, the entire job machinery.

**Dispatch in three places, each by a different key:**
- **SCAN** — `scanner.scan_one` picks the adapter via `adapter_for_path(project_path)` (one shared `os.walk` indexed by `all_extensions()`, *not* one walk per adapter — see risks). A source folder with mixed `.als` + `.flp` yields one `ProjectScan` list, each stamped with its `daw_id`.
- **BACKUP** — no re-dispatch; reuses the `daw_id` already on each `ProjectScan`.
- **VERIFY** — `verifier.verify_snapshot` reads `manifest['daw']` → `adapter_for_id()` → finds the project file by that adapter's `extensions` and re-parses it for the portability check. **This is mandatory**: today line 62 hardcodes `glob('*.als')` + `parse_als`; if left as-is, `.flp` snapshots verify byte-integrity correctly but silently report nothing for portability, masking missing-sample bugs.

**Tracking `project_type` / `daw_id`** (additive, backward-compatible everywhere):
- `models.ProjectScan`: add `daw_id: str = 'ableton'`; rename `als_path` → `project_path` with a deprecated `@property als_path` alias so existing callers/tests keep working during transition.
- `backup_engine.py` manifest dict: add `"daw": scan.daw_id` (and bump with a `"manifest_version": 1` — there is no version field today; adding it now is free, later it's a migration).
- `catalog._migrate()`: add `"daw": "TEXT"` to the existing additive-`ALTER` `new = {...}` dict (the same proven pattern that added `project_id`/`signature`/`verified`). Legacy rows backfill `NULL` → treated as `'ableton'`, which is correct for every existing backup. `latest_signatures` already keys on `project_id` (a path hash), so cross-DAW identity collisions are already impossible.

---

## 3. DAW support & feasibility

Ableton is unusually generous — it records `<OriginalFileSize>`, so `FileRef.size` is populated and the resolver's size-match relink is high-confidence. **No other DAW reliably records a per-sample size or hash.** This is fine: the model defaults `size=0`, the resolver gets the real size from disk, and the verifier re-hashes from the snapshot — so missing in-project size only removes a *pre-flight* cross-check and weakens relink confidence (resolver falls back to path-tail heuristic), it does not weaken backup integrity.

| DAW | Format | Parse difficulty | Parser | Notes |
|---|---|---|---|---|
| **Ableton** | `.als` gzip+XML | done | `parse_als` | records sample size; portable path-rewrite already works |
| **FL Studio** | `.flp` binary chunk | **Medium-Hard** | PyFLP (or hand parser) | binary `FLhd`/`FLdt` event stream; absolute sample paths; **no size**; stock-sample token `%FLStudioFactoryData%` to filter |
| **Reaper** | `.rpp` plain text | **Easy** | `rpp` (PyPI) or ~hundreds of lines | sample refs in `<SOURCE WAVE FILE "path">`; cheapest format to prove the registry |
| **DAWproject** | `.dawproject` zip+XML | **Easy** | stdlib `zipfile`+`ElementTree` | open schema; covers **Bitwig AND Studio One** — but **export-only**, not the default save |
| **Studio One** | `.song` zip | Medium | reverse-engineer Pool entries | undocumented XML in zip; no off-the-shelf parser |
| **Logic** | `.logicx` package | Hard | none | macOS **folder bundle** (not a file); `ProjectData` is undocumented binary; mac-only |
| **Bitwig native** | `.bwproject` zip | Hard | none | proprietary; use DAWproject export instead |
| **Cubase** | `.cpr` binary | Hardest | none | closed binary; not recommended |

**Recommended order:** FL Studio → Reaper → DAWproject → Studio One (`.song`) → Logic (`.logicx`) → Bitwig-native/Cubase last or never. Reaper is deliberately second: a totally different format that's nearly free, proving the registry seam before any reverse-engineering.

**FL Studio specifics & risks:**
- **PyFLP** (`pyflp.parse(path)` → `project.channels.samplers[*].sample_path`) is the fastest route, but: last release **v2.2.1 (June 2023), no commits since July 2023**, **unproven on FL 21+/2024**, and **GPLv3** — which can conflict with shipping a closed-source Electron app. **License review required.** Mitigate by pinning/vendoring, fail-soft (unparseable/FL21 project → "skip, unsupported", never crash), and isolating it. A clean-room hand parser avoids the GPL question entirely but is more work.
- **Coverage gap:** PyFLP's documented iteration is `channels.samplers` only — **playlist audio clips may not be covered**, risking incomplete reference lists. Validate against real projects before claiming FL support.
- **Weaker relink:** no `OriginalFileSize`, so `_match_located` uses its path-tail fallback. Default *find-missing* off (or label "lower-confidence") for FL until size hints exist.
- **Ship FL behind a "beta" badge.** Build it test-first against real `.flp` fixtures across FL versions, exactly as `als_parser` was.

**Bundle/archive formats are a known future gap:** Logic `.logicx`, Studio One `.song`, Bitwig are directories/zips, not single gunzip-able files. `discover_projects` already supports per-adapter custom discovery, but `backup_engine` currently copies `scan.project_path` as a *single file* — before adding those DAWs, add an explicit "collect project artifact" step to the Protocol. Not needed for FL.

---

## 4. Flow-first UX

The flat 5-tab sidebar (Dashboard / Sources & NAS / Scan & Back up / Progress / Browse) is "backwards" because on first run nothing implies the Sources→Scan→Backup order. Replace it with **two modes gated on a `configured` check** (`sources.length > 0 && dest`, derived from the settings `Config` the app already fetches; `Dashboard` already branches on `nas.reachable`). This is mostly a **renderer re-shell** — every existing screen body and backend endpoint is reused verbatim.

**Screen map:**

```
!configured  -->  First-run Setup stepper (the whole window, no rail)
configured   -->  Home (action-first)  +  slim rail: Home / History / Settings
                  Home's "Back up now" launches Scan->Review->Run as an INLINE overlay,
                  not three sidebar tabs.
```

**First-run Setup** (linear, 3 steps + done; Next disabled until each step's requirement is met; reuses `Sources.pickFolder` and `pickDest`):

```
+----------------------------------------------------------+
|  Sessionsafe                            Step 2 of 3      |
|  ( o )---( o )---( o )                                    |
|  Where are your projects?                                |
|  We'll find Ableton (.als) and FL Studio (.flp) here.    |
|  [ + Add a folder ]                                      |
|   /Users/me/Music/Ableton              [remove]          |
|   /Users/me/Documents/FL Studio        [remove]          |
|                              [ Back ]   [ Next > ]        |
+----------------------------------------------------------+
```
Step 1 Welcome (one line: dedup + verify). Step 2 sources. Step 3 destination (reachable dot). Final CTA "Finish & scan" drops to Home and auto-opens the backup flow.

**Steady-state Home** — the four tiles are today's Dashboard tiles verbatim, so **dedup value stays a headline**; the attention list is `build_overview`'s `attention` array unchanged:

```
+--------+-------------------------------------------------+
| Home   |  Sessionsafe                                    |
| Hist.  |   [   Back up now   ]   12 projects ready        |
| Set.   |  +--------+--------+--------+--------+            |
|        |  |Protect.|On NAS  |Saved by|Last    |            |
| (o)NAS |  |9 proj  |41.2 GB |dedup   |backup  |            |
|        |  |        |        |18.1 GB |2h ago v|            |
|        |  +--------+--------+--------+--------+            |
|        |  ! 2 need attention                              |
|        |    Midnight Drive  -- 3 samples missing          |
|        |    Demo v4 (FL)    -- last backup errored         |
+--------+-------------------------------------------------+
```

**Inline backup flow** (overlay launched by "Back up now"; `App.tsx` already lifts `scanProjects`/`pending`/`activeJob` across navigation, so the wiring is essentially present). This is today's `Scan.tsx` body verbatim — checkbox rows, expand-for-missing, **relinked sub-line**, find-missing toggle — plus a **DAW badge per row** and **Live/FL filter chips**:

```
+----------------------------------------------------------+
|  Back up                                          [ X ]   |
|  ( Scan )--( Review )--( Run )       [Live 9] [FL 3]      |
|  [x] (Live) Midnight Drive   24 samples - 312 MB         |
|        ! 3 missing  v                                    |
|  [x] (Live) Trap Beat        14 samples - 88 MB          |
|        v 2 relinked from library                         |
|  [x] (FL)  Demo v4           31 samples - 1.2 GB         |
|  [ ] find missing samples in my libraries  . 5 relinked  |
|                       [ Review 12 . 1.6 GB > ]           |
+----------------------------------------------------------+
```

**How multiple DAWs surface:** ONE unified scan (`scanner` walks all registered extensions in a single pass), one mixed project list sorted by name, disambiguated by a per-row badge (Live / FL) rendered from the new `daw` field. Filter chips do a client-side filter on `ProjectSummary[].daw` — no new endpoint. Users think in *songs*, not file formats, so a single "everything to protect" list beats parallel per-DAW tabs.

**Where Verify / relink / dedup live:**
- **Dedup** — a headline Home tile ("Saved by dedup 18.1 GB"), straight from `build_overview.saved_bytes`.
- **Verify** — the per-snapshot action in History (today's Browse, renamed). The `VerifyResult` card is kept verbatim: present/checked, missing-in-backup, corrupted, "opens standalone elsewhere" (portable), and the relinked-from-library list. A "Verify now" shortcut also appears on the post-backup overlay result.
- **Relinked vs missing** — colored sub-lines on every project row, exactly as today, in scan/review and in verify results.

**Empty/edge states:** `!configured` → Setup is the whole window. `configured` + 0 snapshots → tiles hidden, single "No backups yet — back up your 12 projects" card. NAS offline → "On NAS" tile shows "offline", "Back up now" disabled with "Reconnect in Settings". Scan finds 0 → "No Ableton or FL Studio projects in your folders — check Settings". A `configured` pre-paint settings fetch needs a neutral **loading splash** distinct from both modes so a slow sidecar can't flash the wrong screen; reuse Dashboard's existing service-error card for "can't reach service". A scheduled/background backup must surface a **"backup running" banner on Home**, since there's no longer a Progress tab to navigate to.

**Threading `daw` to the renderer:** add `daw` to `ProjectSummary`, `Snapshot`, `ProjectRow` in `types.ts`; `service.scan_summary` adds `"daw": p.daw_id` to each dict (line 123, alongside renaming/aliasing `als_path`→`project_path`); `run_backup` passes `p.daw_id` into `record_snapshot`. `api.ts` already passes through whatever JSON it gets, so only the type + badge render change.

---

## 5. Phased migration plan

Each phase is independently shippable behind one gate: **the 95 backend + 8 renderer tests stay green, unmodified, through Phase 4.** Only Phase 5 (rename) may edit test literals. Tests assert exact paths like `AbletonBackups/projects/Song/<ts>/Song.als`, so keeping public functions as pass-throughs is what makes each extraction provably no-op. All data migrations are additive (a catalog column) or shimmed (the dest-folder rename); no schema downgrade is ever required, so every phase reverts by reverting its single commit.

**Phase 0 — Seam prep.** Rename `ProjectScan.als_path` → `project_path` with a backward-compat `@property als_path` alias; add a `dest_root_name()` helper (still returns `"AbletonBackups"`). No behavior change.
*Tests:* existing suite green via the alias.

**Phase 1 — Adapter extraction (keystone).** Add `daws/base.py` (Protocol), `daws/registry.py`, `daws/ableton.py` wrapping today's `parse_als`/`find_als` verbatim. Make `parse_als`/`find_als` thin pass-throughs. Route `scanner.scan_one`/`scan_projects` and `verifier` through the registry. Provably no-op.
*Tests:* add `test_adapters_registry.py` (extension routing). Existing tests prove no-op, unmodified.
*Data migration:* none.

**Phase 2 — `daw` tracking + adapter-driven verify.** Add `daw_id` to `ProjectScan`, `"daw"` (+ `"manifest_version"`) to the manifest, `"daw": "TEXT"` to `catalog._migrate()` (legacy rows default `'ableton'`). **Convert `verifier`'s portability re-parse to `manifest['daw']` → `adapter_for_id` → adapter's `parse_project` — do not skip this; it's the silent-regression trap.** Thread `daw_id` into `scan_summary`/`record_snapshot`.
*Tests:* add `test_catalog_daw.py` (legacy row → `'ableton'`, new row stores type) + a manifest-field assert + a verifier test that a non-`.als` manifest verifies portability via the right adapter.
*Data migration:* one additive `ALTER` (proven pattern); legacy manifests with no `daw` key read as `'ableton'`.

**Phase 3 — FL Studio adapter (experimental).** Add `daws/flstudio.py` with a real `.flp` parser (PyFLP pinned/vendored *or* hand parser per the license decision), filter `%FLStudioFactoryData%`, `size=0`. Ship behind a "beta" badge; default find-missing to lower-confidence. `resolver`/`backup_engine`/`catalog`/`verifier` reused unchanged — this phase is the proof the abstraction holds.
*Tests:* add `tests/fixtures/*.flp` + `test_flstudio_adapter.py` mirroring `test_als_parser`/`test_scanner`; assert `.flp` + `.als` coexist in one scan.
*Data migration:* none.

**Phase 4 — Flow-first UX shell.** Add the `configured` gate in `App.tsx`, the 3-step Setup stepper, the action-first Home, and the inline Scan→Review→Run overlay reusing existing leaf screens as steps; rename Browse → History; add the DAW badge + filter chips. The 8 renderer tests cover `api.ts`/`useProgress`/`sidecar`, **not** `App` routing, so a new shell adds zero test churn. Optionally keep the flat tabs behind a flag for one release.
*Tests:* add a renderer wizard step-order test; existing 8 unchanged.
*Data migration:* none.

**Phase 5 — Rename/rebrand (last, shimmed).** Rename package `ablebackup` → `sessionsafe` (40+ imports + `-m ablebackup.server` spawn string in `sidecar.js` + `ABLEBACKUP_*` env vars + `~/.ablebackup/catalog.db`), Electron package name, Nav/notification copy, and the dest root `"AbletonBackups"` → neutral. **Behind a read-legacy compat shim:** if the new dest folder is absent but `AbletonBackups` exists, read it (existing snapshots' `dir` column and `_pool` live under that root — a blind rename orphans every existing backup and breaks dedup continuity). Both old and new names must be in `SKIP_DIRS`/`_SKIP_DIRS` or a scan descends into prior backups.
*Tests:* `test_dest_compat.py` (reads legacy `AbletonBackups` when new root absent); this is the only phase allowed to edit the `AbletonBackups`/import-path test literals.
*Data migration:* one-time, shimmed dest-folder rename; `catalog.db`/env-var migration per the owner's back-compat decision.

**Deliberately held constant** to keep blast radius small: `project_id` derivation (changing *what* gets hashed force-re-backs-up everything via `latest_signatures`), and the catalog's `project_name` grouping (a `project_id`/`(name, daw)` regrouping is an orthogonal follow-up — see open questions).

---

## 6. Open questions for you

1. **Product name + bundle id.** Confirm **Sessionsafe** vs Trackvault vs another, then lock the `appId` (none exists yet — clean slate) and the on-disk dest root name before any installer ships.
2. **Dest folder rename.** Keep `"AbletonBackups"` (no migration, mis-branded for FL users) or move to a neutral name with the read-legacy shim? And **one shared dedup pool across all DAWs** (max space savings, recommended, with the `daw` column driving a per-DAW filter) or **per-DAW subfolders** (cleaner to browse/delete)?
3. **First DAW after FL.** Prioritize by ease (**Reaper** — plain text, nearly free, proves the registry) or by reach (Logic's large mac base, but reverse-engineered)? Recommendation: Reaper next, then DAWproject (two DAWs for one parser, export-only).
4. **PyFLP / GPLv3.** Is the app distributed closed-source/commercially? That decides whether GPLv3 PyFLP is acceptable (vendor + isolate) or whether we write a clean-room `.flp` parser.
5. **FL v1 scope.** Samples-only (ships far faster, under-reports sampler-heavy projects and may miss playlist audio clips) or full reference coverage? And ship FL as a labeled **beta**, given binary-parse risk + weaker relink?
6. **Source-folder model.** One shared "where are your projects" list all DAWs scan (matches reality, recommended) vs per-DAW source trees? And **per-DAW default sample libraries** (`AbletonAdapter` → Splice; FL → Image-Line packs) surfaced on the adapter for first-run auto-detect?
7. **First-run wizard.** Strictly modal until finished, or skippable once a dest is set (with every step also reachable from Settings)? And do we keep both shells long-term or delete the flat Nav after a deprecation window?
8. **History identity.** Keep grouping by `project_name` (badge-only disambiguation; a Live "Demo" and FL "Demo" would merge in history) or move to `project_id` / `(name, daw)` so identically-named projects never merge? Storage already isolates them via `project_id`.
9. **Telemetry posture.** Hard rule of zero analytics/crash reporting (clean trust story, but no usage data to prioritize the DAW roadmap) vs. opt-in anonymized crash reports?

---

**Key files to touch.** Backend: `models.py`, `scanner.py`, `verifier.py`, `service.py`, `backup_engine.py`, `catalog.py`, `api/app.py`, `api/schemas.py`, plus a new `daws/` package (`base.py`, `registry.py`, `ableton.py`, `flstudio.py`); reused unchanged: `resolver.py`, `locator.py`, `hashing.py`, `scheduler.py`, `api/progress.py`, `api/auth.py`. Renderer: `electron/src/App.tsx`, `components/Nav.tsx`, `screens/{Dashboard,Sources,Scan,Review,Backup,Browse}.tsx`, `src/types.ts`, `src/api.ts`. Rename surface (Phase 5): `electron/electron/sidecar.js`, `electron/electron/main.js`, `electron/package.json`, `backend/README.md`.
