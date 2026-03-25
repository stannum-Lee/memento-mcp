import test from "node:test";
import assert from "node:assert/strict";
import { MemoryManager } from "../../lib/memory/MemoryManager.js";

test("reflect skips noisy session_reflect items before persistence", async () => {
  const mm = new MemoryManager();
  let seq = 0;

  mm.store.insert = async () => `frag-${++seq}`;
  mm.index.index = async () => {};
  mm.index.clearWorkingMemory = async () => {};
  mm.factory.create = (params) => ({
    ...params,
    keywords: [],
    type: params.type,
    content: params.content
  });
  mm.factory.splitAndCreate = (text) => [{ content: text }];
  mm._autoLinkSessionFragments = async () => {};

  const result = await mm.reflect({
    sessionId: "reflect-noise-filter-session",
    agentId: "test",
    summary: [
      "AI 에이전트가 '77340f5745494885962d10ac6848edce'라는 특정 ID를 사용했습니다.",
      "PowerShell을 기본 shell로 유지한다."
    ],
    decisions: [
      "9 files changed, 934 insertions(+), 8 deletions(-)",
      "PowerShell을 기본 shell로 유지한다."
    ]
  });

  assert.equal(result.count, 2);
  assert.deepEqual(
    result.fragments.map((fragment) => fragment.content),
    ["PowerShell을 기본 shell로 유지한다.", "PowerShell을 기본 shell로 유지한다."]
  );
});
