import test from "node:test";
import assert from "node:assert/strict";
import { MorphemeIndex } from "../../lib/memory/MorphemeIndex.js";

test("MorphemeIndex fallback tokenization keeps Korean content words", () => {
  const index = new MorphemeIndex();
  const tokens = index._fallbackTokenize("형태소 기능과 relation 기능의 품질을 함께 검증하고 싶습니다.", 10);

  assert.deepEqual(tokens, ["형태소", "기능", "relation", "품질", "검증"]);
});

test("MorphemeIndex merges Gemini tokens with fallback without duplicates", () => {
  const index = new MorphemeIndex();
  const merged = index._mergeTokens(["형태소", "품질"], ["형태소", "기능", "검증"], 10);

  assert.deepEqual(merged, ["형태소", "품질", "기능", "검증"]);
});

test("MorphemeIndex filters diff and id noise during fallback tokenization", () => {
  const index = new MorphemeIndex();
  const tokens = index._fallbackTokenize(
    "16 files changed, 33 insertions(+), deadbeefcafebabe useful workflow check",
    10
  );

  assert.deepEqual(tokens, ["useful", "workflow", "check"]);
});

test("MorphemeIndex skips tokenization for synthetic noise fragments", async () => {
  const index = new MorphemeIndex();
  const tokens = await index.tokenize("42 files changed, 9 insertions(+), abcdef1234567890");

  assert.deepEqual(tokens, []);
});
