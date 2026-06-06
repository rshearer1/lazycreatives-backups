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
