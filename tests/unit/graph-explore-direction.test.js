import test from "node:test";
import assert from "node:assert/strict";
import { MemoryManager } from "../../lib/memory/MemoryManager.js";

test("graphExplore preserves incoming resolved_by edge direction for an error-root RCA chain", async () => {
  const startId = "frag-error";
  const store = {
    getById: async (id) => ({ id, key_id: null }),
    getRCAChain: async () => ([
      {
        id: startId,
        content: "error root",
        type: "error",
        importance: 0.9,
        topic: "debug-graph",
        relation_type: null,
        depth: 0,
        edge_from: null,
        edge_to: null
      },
      {
        id: "frag-cause",
        content: "cause fragment",
        type: "fact",
        importance: 0.5,
        topic: "debug-graph",
        relation_type: "caused_by",
        depth: 1,
        edge_from: startId,
        edge_to: "frag-cause"
      },
      {
        id: "frag-procedure",
        content: "procedure fragment",
        type: "procedure",
        importance: 0.6,
        topic: "debug-graph",
        relation_type: "resolved_by",
        depth: 1,
        edge_from: "frag-procedure",
        edge_to: startId
      }
    ])
  };

  const mm = MemoryManager.create({ store });
  const result = await mm.graphExplore({ startId, agentId: "test-agent" });

  assert.equal(result.startId, startId);
  assert.equal(result.success, undefined);
  assert.deepEqual(
    result.edges,
    [
      { from: startId, to: "frag-cause", relation_type: "caused_by" },
      { from: "frag-procedure", to: startId, relation_type: "resolved_by" }
    ]
  );
});
