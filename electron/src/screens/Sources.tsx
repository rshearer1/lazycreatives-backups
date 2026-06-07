import { useEffect, useState } from "react";
import { makeApi } from "../api";
import type { Config } from "../types";
import { Button } from "../components/Button";
import { PageHeader } from "../components/PageHeader";
import { Info } from "../components/Info";
import { fmtInterval, fmtClock } from "../format";

const api = makeApi();

const PRESETS = [
  { label: "Off", min: 0 },
  { label: "Hourly", min: 60 },
  { label: "Every 6h", min: 360 },
  { label: "Daily", min: 1440 },
  { label: "Weekly", min: 10080 },
];

export function Sources() {
  const [cfg, setCfg] = useState<Config>({ sources: [], dest: "", interval_minutes: 0, libraries: [] });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [nextRun, setNextRun] = useState<string | null>(null);

  function refreshNextRun() {
    api.overview().then((o) => setNextRun(o.schedule.next_run ?? null)).catch(() => {});
  }
  function load() {
    setLoadError(false);
    api.getSettings()
      .then((c) => { setCfg(c); setLoaded(true); })
      .catch(() => setLoadError(true));
  }
  useEffect(() => { load(); refreshNextRun(); }, []);

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
    if (!loaded) return;  // never overwrite stored settings with an un-loaded default
    setSaveError(null);
    try {
      const next = await api.saveSettings({ ...cfg, interval_minutes: Math.max(0, cfg.interval_minutes) });
      setCfg(next); setSaved(true); setTimeout(() => setSaved(false), 1500);
      refreshNextRun();
    } catch (e: any) {
      setSaveError(e.message || "Save failed");
    }
  }

  if (loadError) {
    return (
      <>
        <PageHeader title="Settings" subtitle="Where to find your projects, and where to keep the backups." />
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <strong style={{ color: "var(--danger)" }}>Couldn't reach the backup service.</strong>
          <p className="sub" style={{ margin: "8px 0 14px" }}>Settings weren't loaded — saving is disabled so your stored config isn't overwritten.</p>
          <Button variant="ghost" onClick={load}>Retry</Button>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Where to find your projects, and where to keep the backups."
        actions={<Button onClick={save} disabled={!loaded}>{saved ? "Saved ✓" : "Save settings"}</Button>}
      />

      {saveError && <div className="card" style={{ borderColor: "var(--danger)", color: "var(--danger)", marginBottom: 16 }}>{saveError}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Source folders</h2>
          <Button variant="ghost" onClick={addSource} disabled={!loaded}>+ Add folder</Button>
        </div>
        {cfg.sources.length === 0 && <p className="sub" style={{ margin: 0 }}>{loaded ? "No folders yet." : "Loading…"}</p>}
        {cfg.sources.map((s) => (
          <div key={s} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", gap: 12 }}>
            <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s}</span>
            <button className="linkbtn" onClick={() => removeSource(s)} style={{ color: "var(--danger)", flexShrink: 0 }}>remove</button>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ display: "flex", alignItems: "center" }}>Backup destination
          <Info text="A folder on your own NAS or drive where backups are kept. No cloud, no subscription — you own every copy." /></h2>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input readOnly value={cfg.dest} placeholder="No destination set"
            style={{ flex: 1, background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)", padding: "10px 12px", borderRadius: 8 }} />
          <Button variant="ghost" onClick={pickDest} disabled={!loaded}>Choose…</Button>
        </div>
        <div className="sub" style={{ margin: "8px 0 0", fontSize: 12 }}>
          <span style={{ color: cfg.dest ? "var(--accent-2)" : "var(--text-dim)" }}>●</span>{" "}
          {cfg.dest ? "Destination set" : "Pick a mounted NAS folder, external drive, or any folder"}
        </div>
      </div>

      <div className="card">
        <h2 style={{ display: "flex", alignItems: "center" }}>Automatic backup
          <Info text="Leave the app running (it lives in your menu-bar tray) and it backs up on this schedule on its own — set it and forget it." /></h2>
        <div className="seg" role="group" style={{ marginTop: 10, flexWrap: "wrap" }}>
          {PRESETS.map((p) => (
            <button key={p.min} disabled={!loaded}
              className={`seg__opt${cfg.interval_minutes === p.min ? " seg__opt--on" : ""}`}
              onClick={() => setCfg({ ...cfg, interval_minutes: p.min })}>{p.label}</button>
          ))}
        </div>
        <div className="sub" style={{ margin: "11px 0 0", fontSize: 12.5 }}>
          {cfg.interval_minutes > 0 ? (
            <span style={{ color: "var(--accent-2)" }}>
              ✓ On — backs up {fmtInterval(cfg.interval_minutes).replace("every ", "every ")}
              {nextRun ? ` · next ${fmtClock(nextRun)}` : ""}. Keep the app running (menu-bar tray).
            </span>
          ) : "Off — you'll back up manually whenever you like."}
        </div>
      </div>
    </>
  );
}
