import test from "node:test";
import assert from "node:assert/strict";
import { buildMemoryQualityReport } from "../../lib/memory/MemoryQualityReport.js";

test("memory quality report passes for clean durable memory samples", () => {
  const report = buildMemoryQualityReport({
    fragments: [
      {
        id: "frag-1",
        topic: "trrc",
        type: "procedure",
        source: "remember",
        content: "TRRC preset validation matrix was updated for report flow."
      },
      {
        id: "frag-2",
        topic: "paperbanana",
        type: "fact",
        source: "remember",
        content: "OAuth bridge fallback is Claude when Codex route is unavailable."
      }
    ],
    morphemes: [
      { morpheme: "형태소" },
      { morpheme: "검증" },
      { morpheme: "relation" }
    ],
    relationCounts: [
      { relation_type: "related", count: 3 },
      { relation_type: "resolved_by", count: 1 }
    ],
    searchEventCount: 5,
    linkedFeedbackCount: 2
  });

  assert.equal(report.outcome, "pass");
  assert.equal(report.metrics.fragments.noisyCount, 0);
  assert.equal(report.metrics.morphemes.noisyCount, 0);
});

test("memory quality report fails for synthetic topics and diff/id morpheme noise", () => {
  const report = buildMemoryQualityReport({
    fragments: [
      {
        id: "frag-noise-1",
        topic: "memento-e2e-20260326",
        type: "fact",
        source: "reflect",
        content: "Synthetic E2E fragment."
      },
      {
        id: "frag-noise-2",
        topic: "session_reflect",
        type: "fact",
        source: "reflect",
        content: "3 files changed, 10 insertions(+), deadbeefcafebabe"
      }
    ],
    morphemes: [
      { morpheme: "files" },
      { morpheme: "12345" },
      { morpheme: "deadbeefcafebabe" }
    ]
  });

  assert.equal(report.outcome, "fail");
  assert.ok(report.checks.some((check) => check.name === "synthetic-topic-fragments" && check.status === "fail"));
  assert.ok(report.checks.some((check) => check.name === "noisy-session-reflect-fragments" && check.status === "fail"));
  assert.ok(report.checks.some((check) => check.name === "noisy-morphemes" && check.status === "fail"));
});
