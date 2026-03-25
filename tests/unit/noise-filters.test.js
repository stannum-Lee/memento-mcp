import test from "node:test";
import assert from "node:assert/strict";
import {
  isNoiseLikeFragment,
  isNoiseLikeStoredMorpheme,
  isNoiseLikeToken,
  shouldSkipContradictionTracking
} from "../../lib/memory/NoiseFilters.js";

test("synthetic memento-e2e topic is treated as noise", () => {
  assert.equal(isNoiseLikeFragment({
    topic: "memento-e2e-573-health-check",
    content: "verification memory",
    source: "test"
  }), true);
});

test("diff summary with hex id is treated as noise", () => {
  assert.equal(isNoiseLikeFragment({
    topic: "contradiction",
    content: "16 files changed, 81 insertions(+), 25 deletions(-), deadbeefcafebabe",
    source: "session:abc123"
  }), true);
});

test("ordinary project memory is not treated as noise", () => {
  assert.equal(isNoiseLikeFragment({
    topic: "trrc",
    content: "TRRC preset sync requires contract and validation matrix updates together.",
    source: "session:work"
  }), false);
});

test("session_reflect is excluded from contradiction tracking", () => {
  assert.equal(shouldSkipContradictionTracking({
    topic: "session_reflect",
    content: "Decided to keep PowerShell as the default shell."
  }), true);
});

test("session_reflect fragment with hex identifier is treated as noise", () => {
  assert.equal(isNoiseLikeFragment({
    topic: "session_reflect",
    content: "AI 에이전트가 '77340f5745494885962d10ac6848edce'라는 특정 ID를 사용했습니다."
  }), true);
});

test("session_reflect contradiction audit fragment is treated as noise", () => {
  assert.equal(isNoiseLikeFragment({
    topic: "session_reflect",
    content: "[모순 해결] \"9 files changed, 839 insertions(+), 8 deletions(-)\" 파편이 \"9 files changed, 934 insertions(+), 8 deletions(-)\" 으로 대체됨."
  }), true);
});

test("hex/id and diff stopwords are rejected as morphemes", () => {
  assert.equal(isNoiseLikeToken("deadbeefcafebabe", { sourceText: "16 files changed" }), true);
  assert.equal(isNoiseLikeToken("files", { sourceText: "16 files changed" }), true);
  assert.equal(isNoiseLikeStoredMorpheme("changed"), true);
  assert.equal(isNoiseLikeToken("workflow", { sourceText: "normal memory text" }), false);
});
