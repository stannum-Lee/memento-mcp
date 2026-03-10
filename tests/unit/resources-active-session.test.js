import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureEnv = path.resolve(__dirname, "../fixtures/resources-test.env");
const resourcesModuleUrl = `${pathToFileURL(path.resolve(__dirname, "../../lib/tools/resources.js")).href}?case=${Date.now()}`;

let readActiveSessionResource;
let readResource;

before(async () => {
  process.env.MEMENTO_ENV_FILE = fixtureEnv;
  ({ readActiveSessionResource, readResource } = await import(resourcesModuleUrl));
});

after(() => {
  delete process.env.MEMENTO_ENV_FILE;
});

describe("memory://active-session resource", () => {
  test("returns tracked session activity when Redis-backed tracker data exists", async () => {
    const result = await readActiveSessionResource(
      { _sessionId: "session-a" },
      {
        tracker: {
          getActivity: async (sessionId) => ({
            startedAt: "2026-03-10T00:00:00.000Z",
            lastActivity: "2026-03-10T00:10:00.000Z",
            toolCalls: { remember: 2 },
            echoSessionId: sessionId
          })
        },
        redisState: { enabled: true, status: "ready" }
      }
    );

    const payload = JSON.parse(result.contents[0].text);
    assert.equal(payload.sessionId, "session-a");
    assert.equal(payload.status, "active");
    assert.equal(payload.source, "session-activity-tracker");
    assert.equal(payload.redis.status, "ready");
    assert.deepEqual(payload.toolCalls, { remember: 2 });
    assert.equal(payload.echoSessionId, "session-a");
  });

  test("returns fallback payload instead of internal error when Redis is unavailable", async () => {
    const result = await readActiveSessionResource(
      { sessionId: "session-b" },
      {
        tracker: {
          getActivity: async () => null
        },
        redisState: { enabled: true, status: "reconnecting" }
      }
    );

    const payload = JSON.parse(result.contents[0].text);
    assert.equal(payload.sessionId, "session-b");
    assert.equal(payload.status, "unavailable");
    assert.equal(payload.source, "fallback");
    assert.match(payload.message, /tracker unavailable/i);
    assert.equal(payload.redis.status, "reconnecting");
  });

  test("returns a readable payload when no session id is provided", async () => {
    const result = await readActiveSessionResource(
      {},
      {
        tracker: {
          getActivity: async () => {
            throw new Error("should not be called");
          }
        },
        redisState: { enabled: false, status: "disabled" }
      }
    );

    const payload = JSON.parse(result.contents[0].text);
    assert.equal(payload.sessionId, "unknown");
    assert.equal(payload.status, "unavailable");
    assert.equal(payload.message, "Session ID not provided");
    assert.equal(payload.redis.enabled, false);
  });

  test("readResource delegates memory://active-session to the same safe path", async () => {
    const result = await readResource(
      "memory://active-session",
      { _sessionId: "session-c" },
      {
        tracker: {
          getActivity: async () => ({ reflected: false })
        },
        redisState: { enabled: true, status: "ready" }
      }
    );

    const payload = JSON.parse(result.contents[0].text);
    assert.equal(payload.sessionId, "session-c");
    assert.equal(payload.status, "active");
    assert.equal(payload.reflected, false);
  });
});
