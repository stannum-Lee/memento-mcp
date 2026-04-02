import test from "node:test";
import assert from "node:assert/strict";
import { autoReflect } from "../../lib/memory/AutoReflect.js";
import { SessionActivityTracker } from "../../lib/memory/SessionActivityTracker.js";
import { MemoryManager } from "../../lib/memory/MemoryManager.js";

const originalGetActivity = SessionActivityTracker.getActivity;
const originalMarkReflected = SessionActivityTracker.markReflected;
const originalGetInstance = MemoryManager.getInstance;
const originalDisableGemini = process.env.AUTOREFLECT_DISABLE_GEMINI;

test.afterEach(() => {
  SessionActivityTracker.getActivity = originalGetActivity;
  SessionActivityTracker.markReflected = originalMarkReflected;
  MemoryManager.getInstance = originalGetInstance;
  if (originalDisableGemini === undefined) {
    delete process.env.AUTOREFLECT_DISABLE_GEMINI;
  } else {
    process.env.AUTOREFLECT_DISABLE_GEMINI = originalDisableGemini;
  }
});

test("autoReflect skips minimal reflect when only noisy keywords exist", async () => {
  process.env.AUTOREFLECT_DISABLE_GEMINI = "1";
  let marked = 0;
  let reflectCalled = 0;

  SessionActivityTracker.getActivity = async () => ({
    reflected: false,
    toolCalls: { recall: 2 },
    keywords: ["files", "changed", "deadbeefcafebabe"],
    fragments: ["frag-1"],
    startedAt: "2026-03-29T01:00:00.000Z",
    lastActivity: "2026-03-29T01:01:00.000Z"
  });
  SessionActivityTracker.markReflected = async () => { marked += 1; };
  MemoryManager.getInstance = () => ({
    reflect: async () => {
      reflectCalled += 1;
      return { count: 99 };
    }
  });

  const result = await autoReflect("auto-reflect-noise-session", "test");

  assert.equal(reflectCalled, 0);
  assert.equal(marked, 1);
  assert.equal(result.count, 0);
  assert.equal(result.breakdown.skipped, true);
});

test("autoReflect persists minimal reflect when durable keywords remain", async () => {
  process.env.AUTOREFLECT_DISABLE_GEMINI = "1";
  let marked = 0;
  let reflectArgs = null;

  SessionActivityTracker.getActivity = async () => ({
    reflected: false,
    toolCalls: { remember: 1, recall: 1 },
    keywords: ["trrc", "preset", "files"],
    fragments: ["frag-1", "frag-2"],
    startedAt: "2026-03-29T01:00:00.000Z",
    lastActivity: "2026-03-29T01:02:00.000Z"
  });
  SessionActivityTracker.markReflected = async () => { marked += 1; };
  MemoryManager.getInstance = () => ({
    reflect: async (args) => {
      reflectArgs = args;
      return { count: 1, fragments: [{ id: "frag-1" }], breakdown: { summary: 1 } };
    }
  });

  const result = await autoReflect("auto-reflect-durable-session", "test");

  assert.equal(marked, 1);
  assert.equal(result.count, 1);
  assert.equal(reflectArgs.sessionId, "auto-reflect-durable-session");
  assert.equal(reflectArgs.agentId, "test");
  assert.match(reflectArgs.summary, /trrc/);
  assert.match(reflectArgs.summary, /preset/);
});
