import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleResourceTemplatesList } from "../../lib/jsonrpc.js";
import {
  closeLegacySseSession,
  closeStreamableSession,
  createLegacySseSession,
  createStreamableSession,
} from "../../lib/sessions.js";
import { MemoryManager } from "../../lib/memory/MemoryManager.js";
import {
  batchRememberDefinition,
  recallDefinition,
  reflectDefinition,
  rememberDefinition,
} from "../../lib/tools/memory-schemas.js";
import { readResource } from "../../lib/tools/resources.js";
import { tool_recall } from "../../lib/tools/memory.js";

const streamableSessionIds = [];
const legacySessionIds = [];

function fakeSseResponse() {
  return {
    end() {},
    flushHeaders() {},
    write() {},
  };
}

function parseJsonResource(result) {
  assert.ok(Array.isArray(result.contents), "resource contents should be an array");
  assert.equal(result.contents.length, 1, "resource should expose exactly one content item");
  return JSON.parse(result.contents[0].text);
}

function assertStableActiveSessionShape(payload) {
  assert.deepStrictEqual(
    Object.keys(payload).sort(),
    ["activity", "redis", "session", "sessionId", "source", "status"].sort(),
  );
  assert.deepStrictEqual(
    Object.keys(payload.redis).sort(),
    ["activityKey", "enabled", "hasActivity", "hasSession", "sessionKey", "status"].sort(),
  );
}

afterEach(async () => {
  while (streamableSessionIds.length > 0) {
    await closeStreamableSession(streamableSessionIds.pop());
  }
  while (legacySessionIds.length > 0) {
    await closeLegacySseSession(legacySessionIds.pop());
  }
});

describe("memory://active-session contract", () => {
  it("returns the stable shape when _sessionId is missing", async () => {
    const payload = parseJsonResource(await readResource("memory://active-session", {}));

    assertStableActiveSessionShape(payload);
    assert.equal(payload.sessionId, null);
    assert.equal(payload.status, "missing_session_id");
    assert.equal(payload.source, "none");
    assert.equal(payload.session, null);
    assert.equal(payload.activity, null);
  });

  it("returns the stable shape for an active streamable session", async () => {
    const sessionId = await createStreamableSession(true);
    streamableSessionIds.push(sessionId);

    const payload = parseJsonResource(await readResource("memory://active-session", { _sessionId: sessionId }));

    assertStableActiveSessionShape(payload);
    assert.equal(payload.sessionId, sessionId);
    assert.equal(payload.status, "active");
    assert.equal(payload.source, "streamable_http");
    assert.equal(payload.session.transport, "streamable_http");
    assert.equal(payload.activity.sessionId, sessionId);
    assert.deepStrictEqual(
      Object.keys(payload.activity).sort(),
      ["fragments", "keywords", "lastActivity", "reflected", "sessionId", "startedAt", "toolCalls"].sort(),
    );
  });

  it("returns the stable shape for an active legacy SSE session", async () => {
    const sessionId = createLegacySseSession(fakeSseResponse());
    legacySessionIds.push(sessionId);

    const payload = parseJsonResource(await readResource("memory://active-session", { _sessionId: sessionId }));

    assertStableActiveSessionShape(payload);
    assert.equal(payload.sessionId, sessionId);
    assert.equal(payload.status, "active");
    assert.equal(payload.source, "legacy_sse");
    assert.equal(payload.session.transport, "legacy_sse");
    assert.equal(payload.activity.sessionId, sessionId);
  });

  it("returns a stable non-active shape for an unknown session id", async () => {
    const sessionId = `missing-${Date.now()}`;
    const payload = parseJsonResource(await readResource("memory://active-session", { _sessionId: sessionId }));

    assertStableActiveSessionShape(payload);
    assert.equal(payload.sessionId, sessionId);
    assert.ok(
      ["redis_disabled", "session_not_found"].includes(payload.status),
      `unexpected status: ${payload.status}`,
    );
    assert.equal(payload.source, "none");
    assert.equal(payload.session, null);
    assert.equal(payload.activity.sessionId, sessionId);
  });
});

describe("MCP resource surface", () => {
  it("keeps resources/templates/list intentionally empty", () => {
    assert.deepStrictEqual(handleResourceTemplatesList(), { resourceTemplates: [] });
  });
});

describe("tool_recall pagination contract", () => {
  const originalGetInstance = MemoryManager.getInstance;

  afterEach(() => {
    MemoryManager.getInstance = originalGetInstance;
  });

  it("forwards totalCount, hasMore, and nextCursor from MemoryManager.recall", async () => {
    const nextCursor = Buffer.from(JSON.stringify({ offset: 1, anchorTime: 1700000000000 })).toString("base64url");

    MemoryManager.getInstance = () => ({
      recall: async () => ({
        fragments: [
          {
            id: "frag-1",
            content: "content",
            topic: "topic",
            type: "fact",
            importance: 0.7,
          },
        ],
        totalCount: 3,
        hasMore: true,
        nextCursor,
        totalTokens: 42,
        searchPath: ["L2"],
      }),
    });

    const result = await tool_recall({
      _sessionId: "session-1",
      agentId: "agent-1",
      topic: "topic",
      includeLinks: false,
      pageSize: 1,
    });

    assert.equal(result.success, true);
    assert.equal(result.count, 1);
    assert.equal(result.totalCount, 3);
    assert.equal(result.hasMore, true);
    assert.equal(result.nextCursor, nextCursor);
    assert.equal(result.totalTokens, 42);
    assert.deepStrictEqual(result.searchPath, ["L2"]);
  });
});

describe("episodic MCP surface contracts", () => {
  it("keeps episode/context fields in remember and batch schemas", () => {
    assert.ok(rememberDefinition.inputSchema.properties.type.enum.includes("episode"));
    assert.ok("contextSummary" in rememberDefinition.inputSchema.properties);
    assert.ok("sessionId" in rememberDefinition.inputSchema.properties);

    const batchProperties = batchRememberDefinition.inputSchema.properties.fragments.items.properties;
    const batchTypeEnum = batchProperties.type.enum;
    assert.ok(batchTypeEnum.includes("episode"));
    assert.ok("source" in batchProperties);
    assert.ok("contextSummary" in batchProperties);
    assert.ok("sessionId" in batchProperties);
  });

  it("keeps episode-aware recall and reflect input fields", () => {
    assert.ok(recallDefinition.inputSchema.properties.type.enum.includes("episode"));
    assert.ok("includeContext" in recallDefinition.inputSchema.properties);
    assert.ok("sessionId" in reflectDefinition.inputSchema.properties);
    assert.ok("narrative_summary" in reflectDefinition.inputSchema.properties);
  });
});
