/**
 * SchedulerRegistry 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-31
 */

import { SchedulerRegistry } from "../lib/scheduler-registry.js";

describe("SchedulerRegistry", () => {
  it("tracks job success", () => {
    const reg = new SchedulerRegistry();
    reg.recordSuccess("consolidate", { affected: 5 });
    const jobs = reg.getAll();
    expect(jobs.consolidate.lastSuccess).toBeDefined();
    expect(jobs.consolidate.lastSummary).toEqual({ affected: 5 });
    expect(jobs.consolidate.runCount).toBe(1);
    expect(jobs.consolidate.failureCount).toBe(0);
  });

  it("tracks job failure", () => {
    const reg = new SchedulerRegistry();
    reg.recordFailure("embedding", new Error("timeout"));
    const jobs = reg.getAll();
    expect(jobs.embedding.lastError).toBe("timeout");
    expect(jobs.embedding.failureCount).toBe(1);
  });

  it("tracks multiple runs", () => {
    const reg = new SchedulerRegistry();
    reg.recordSuccess("consolidate");
    reg.recordSuccess("consolidate");
    reg.recordFailure("consolidate", new Error("db"));
    const jobs = reg.getAll();
    expect(jobs.consolidate.runCount).toBe(3);
    expect(jobs.consolidate.failureCount).toBe(1);
  });

  it("getAll returns independent copy", () => {
    const reg  = new SchedulerRegistry();
    reg.recordSuccess("job1", { x: 1 });
    const snap = reg.getAll();
    snap.job1.runCount = 999;
    expect(reg.getAll().job1.runCount).toBe(1);
  });

  it("lastFailure is null before any failure", () => {
    const reg = new SchedulerRegistry();
    reg.recordSuccess("job1");
    expect(reg.getAll().job1.lastFailure).toBeNull();
  });
});
