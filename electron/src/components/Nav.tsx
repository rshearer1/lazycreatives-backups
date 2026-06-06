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
