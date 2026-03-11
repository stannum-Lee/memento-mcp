import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("tool_recall pagination surface", () => {
  test("tool_recall preserves pagination metadata from MemoryManager.recall", async () => {
    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const { SessionActivityTracker } = await import("../../lib/memory/SessionActivityTracker.js");
    const { tool_recall } = await import("../../lib/tools/memory.js");

    const originalGetInstance = MemoryManager.getInstance;
    const originalRecord = SessionActivityTracker.record;

    MemoryManager.getInstance = () => ({
      recall: async () => ({
        fragments: [
          {
            id: "frag-1",
            content: "remember me",
            topic: "test",
            type: "fact",
            importance: 0.7
          }
        ],
        totalCount : 2,
        nextCursor : "cursor-1",
        hasMore    : true,
        totalTokens: 42,
        searchPath : "L1:1"
      })
    });
    SessionActivityTracker.record = () => Promise.resolve();

    try {
      const result = await tool_recall({ _sessionId: "session-1", text: "remember", pageSize: 1 });
      assert.equal(result.success, true);
      assert.equal(result.count, 1);
      assert.equal(result.totalCount, 2);
      assert.equal(result.nextCursor, "cursor-1");
      assert.equal(result.hasMore, true);
      assert.equal(result.totalTokens, 42);
    } finally {
      MemoryManager.getInstance = originalGetInstance;
      SessionActivityTracker.record = originalRecord;
    }
  });
});
