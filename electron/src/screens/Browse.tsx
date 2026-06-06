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
