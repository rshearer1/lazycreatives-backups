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
