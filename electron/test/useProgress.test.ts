import { describe, it, expect } from "vitest";
import { reduceProgress, initialProgress } from "../src/useProgress";

describe("reduceProgress", () => {
  it("tracks counts and completion across a run", () => {
    let s = initialProgress();
    s = reduceProgress(s, { type: "backup_start", project_count: 2, timestamp: "t" });
    expect(s.total).toBe(2);
    expect(s.done).toBe(false);
    s = reduceProgress(s, { type: "project_start", index: 0, project_name: "A", total: 2 });
    expect(s.current).toBe("A");
    s = reduceProgress(s, { type: "project_done", index: 0, project_name: "A", file_count: 3, missing_count: 0 });
    expect(s.completed).toBe(1);
    s = reduceProgress(s, { type: "project_error", index: 1, project_name: "B", error: "x" });
    expect(s.errors).toBe(1);
    s = reduceProgress(s, { type: "backup_done", ok_count: 1, error_count: 1 });
    expect(s.done).toBe(true);
    expect(s.log.length).toBeGreaterThanOrEqual(4);
  });
});
