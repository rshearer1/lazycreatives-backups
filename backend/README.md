# ablebackup engine

Plan 1 of the Ableton Project Backup Tool: the standalone backup engine + CLI.

## Usage

    python -m ablebackup.cli scan --source "C:\Users\me\Music\Ableton"

    python -m ablebackup.cli backup \
        --source "C:\Users\me\Music\Ableton" \
        --dest "Z:\\" \
        --db "%LOCALAPPDATA%\ablebackup\catalog.db"

`scan` lists discovered projects and how many referenced files exist / are missing.
`backup` writes a deduplicated dated snapshot of every project under
`<dest>/AbletonBackups/projects/<Project>/<timestamp>/` and records history in the catalog DB.

## What it does / does not do

- Resolves every sample reference in each `.als` (relative + absolute, modern + legacy formats),
  copies the complete self-contained project, and flags any missing files.
- Dedups identical files across snapshots via a content pool + hardlinks (falls back to copies
  on filesystems without hardlink support).
- Does NOT back up plugins/VSTs (installed software). Does NOT render stems.

Next plans: FastAPI/scheduler layer, then the Electron + web UI.
