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
