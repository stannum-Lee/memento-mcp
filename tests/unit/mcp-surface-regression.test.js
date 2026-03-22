import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

async function readText(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("transport injection contract", () => {
  it("injects _sessionId for tools/call in both supported HTTP transport handlers", async () => {
    const source = await readText("../../lib/http-handlers.js");
    const matches = source.match(/msg\.method === "tools\/call" && msg\.params\?\.arguments[\s\S]{0,200}?msg\.params\.arguments\._sessionId\s*=\s*sessionId/g) || [];

    assert.equal(matches.length, 2, "expected streamable and legacy tools/call injection paths");
  });

  it("injects _sessionId for resources/read in both supported HTTP transport handlers", async () => {
    const source = await readText("../../lib/http-handlers.js");
    const matches = source.match(/msg\.method === "resources\/read" && msg\.params[\s\S]{0,120}?msg\.params\._sessionId\s*=\s*sessionId/g) || [];

    assert.equal(matches.length, 2, "expected streamable and legacy resources/read injection paths");
  });
});

describe("schema preflight contract", () => {
  it("requires temporal, supersession, EMA, and link-weight capabilities", async () => {
    const source = await readText("../../lib/schema-preflight.js");

    for (const required of [
      "valid_from",
      "valid_to",
      "superseded_by",
      "ema_activation",
      "ema_last_updated",
      "weight",
    ]) {
      assert.ok(source.includes(`"${required}"`), `missing schema capability check for ${required}`);
    }
  });

  it("requires the final relation constraint set including internal co_retrieved", async () => {
    const source = await readText("../../lib/schema-preflight.js");

    for (const relation of [
      "related",
      "caused_by",
      "resolved_by",
      "part_of",
      "contradicts",
      "superseded_by",
      "co_retrieved",
    ]) {
      assert.ok(source.includes(`"${relation}"`), `missing relation preflight for ${relation}`);
    }
  });
});

describe("verifier regression coverage", () => {
  it("keeps the e2e verifier on info/fail-only severity levels", async () => {
    const source = await readText("../../../scripts/verify_memento_end_to_end.ps1");

    assert.ok(!/\bwarn\b/i.test(source), "e2e verifier should not emit warn severity");
    assert.ok(source.includes('Severity "info"'));
    assert.ok(source.includes('Severity "fail"'));
  });

  it("pins the health schema preflight check", async () => {
    const source = await readText("../../../scripts/verify_memento_end_to_end.ps1");

    assert.ok(source.includes('Name "health-schema"'));
    assert.ok(source.includes("Schema preflight is not up."));
  });

  it("pins active-session stable shape and _sessionId injection checks", async () => {
    const source = await readText("../../../scripts/verify_memento_end_to_end.ps1");

    assert.ok(source.includes('Name "resource-active-session-shape"'));
    assert.ok(source.includes('Name "resource-active-session-session-id"'));
    assert.ok(source.includes("memory://active-session did not expose the stable shape."));
    assert.ok(source.includes("_sessionId was not injected into resources/read."));
  });

  it("pins recall pagination and empty resource template surface checks", async () => {
    const source = await readText("../../../scripts/verify_memento_end_to_end.ps1");

    assert.ok(source.includes('Name "tool-recall-pagination"'));
    assert.ok(source.includes("recall exposed totalCount/hasMore/nextCursor."));
    assert.ok(source.includes('Name "resource-templates-list"'));
    assert.ok(source.includes("resources/templates/list must intentionally return an empty surface."));
  });
});

describe("temporal cache regression coverage", () => {
  it("revalidates hot-cache hits against current valid_to state before filtered recall returns them", async () => {
    const source = await readText("../../lib/memory/FragmentSearch.js");

    assert.ok(source.includes("_revalidateHotCache"));
    assert.ok(source.includes("cached.length > 0 && !query.includeSuperseded"));
    assert.ok(source.includes("return cachedFragments"));
    assert.ok(source.includes(".filter(fragment => !fragment.valid_to)"));
  });

  it("deindexes superseded fragments from Redis when remember(...supersedes=...) retires them", async () => {
    const source = await readText("../../lib/memory/MemoryManager.js");

    assert.ok(source.includes("const existing = await this.store.getById(oldId, agentId);"));
    assert.ok(source.includes("await this.index.deindex("));
    assert.ok(source.includes("existing.keywords || []"));
    assert.ok(source.includes("existing.key_id ?? null"));
  });
});

describe("native surface blocked semantics", () => {
  it("treats the current Claude native smoke as environment-blocked when the client is unavailable", async () => {
    const scriptSource = await readText("../../../scripts/verify_memento_native_surface.ps1");

    assert.ok(scriptSource.includes('if ($Client -eq "codex")'));
    assert.ok(scriptSource.includes('status = "unsupported"'));
    assert.ok(scriptSource.includes("Set-BlockedStatus"));
    assert.ok(scriptSource.includes('WaitForExit($TimeoutSeconds * 1000)'));
    assert.ok(scriptSource.includes("Native smoke command timed out after"));
    assert.ok(scriptSource.includes("Claude native surface is blocked because process env auth is unavailable."));

    const artifactUrl = new URL("../../../generated/memento-native/claude-direct-smoke.json", import.meta.url);
    if (!existsSync(artifactUrl)) {
      return;
    }

    const artifact = JSON.parse(await readText("../../../generated/memento-native/claude-direct-smoke.json"));
    assert.equal(artifact.surfaceId, "A-claude");
    assert.notEqual(artifact.status, "green");
    assert.ok(
      artifact.authSource === "missing" || artifact.authSource.startsWith("env-file:"),
      `unexpected authSource: ${artifact.authSource}`,
    );
  });
});
