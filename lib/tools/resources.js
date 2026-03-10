/**
 * Memento MCP Resources definition
 */

import { MEMORY_CONFIG } from "../../config/memory.js";
import { REDIS_ENABLED } from "../config.js";
import { SessionActivityTracker } from "../memory/SessionActivityTracker.js";
import { getPrimaryPool } from "./db.js";
import { redisClient } from "../redis.js";

export const RESOURCES = [
  {
    uri: "memory://stats",
    name: "기억 시스템 통계",
    description: "현재 저장된 파편의 유형별, 계층별 통계 정보를 제공합니다.",
    mimeType: "application/json"
  },
  {
    uri: "memory://topics",
    name: "등록된 주제 목록",
    description: "기억 시스템에 등록된 모든 고유한 주제(topic) 목록을 제공합니다.",
    mimeType: "application/json"
  },
  {
    uri: "memory://config",
    name: "시스템 설정 정보",
    description: "중요도 가중치, 만료 단계값 등 현재 시스템 설정을 제공합니다.",
    mimeType: "application/json"
  },
  {
    uri: "memory://active-session",
    name: "현재 세션 활동 로그",
    description: "현재 세션에서 발생한 도구 호출과 활동 요약을 제공합니다.",
    mimeType: "application/json"
  }
];

export function getActiveSessionId(params = {}) {
  return params._sessionId || params.sessionId || "unknown";
}

export function getRedisState(client = redisClient) {
  if (!REDIS_ENABLED) {
    return { enabled: false, status: "disabled" };
  }

  return {
    enabled: true,
    status: client?.status || "unavailable"
  };
}

export function buildActiveSessionPayload({ sessionId, activity, redisState }) {
  if (activity && typeof activity === "object" && Object.keys(activity).length > 0) {
    return {
      sessionId,
      status: "active",
      source: "session-activity-tracker",
      redis: redisState,
      ...activity
    };
  }

  if (sessionId === "unknown") {
    return {
      sessionId,
      status: "unavailable",
      source: "fallback",
      redis: redisState,
      message: "Session ID not provided"
    };
  }

  const redisReady = redisState.enabled && redisState.status === "ready";
  return {
    sessionId,
    status: redisReady ? "idle" : "unavailable",
    source: "fallback",
    redis: redisState,
    message: redisReady
      ? "No activity recorded yet for this session"
      : `Session activity tracker unavailable (${redisState.status})`
  };
}

export async function readActiveSessionResource(params = {}, deps = {}) {
  const sessionId = getActiveSessionId(params);
  const tracker = deps.tracker || SessionActivityTracker;
  const redisState = deps.redisState || getRedisState(deps.redisClient || redisClient);

  let activity = null;
  if (sessionId !== "unknown") {
    try {
      activity = await tracker.getActivity(sessionId);
    } catch {
      activity = null;
    }
  }

  return {
    contents: [
      {
        uri: "memory://active-session",
        mimeType: "application/json",
        text: JSON.stringify(
          buildActiveSessionPayload({ sessionId, activity, redisState }),
          null,
          2
        )
      }
    ]
  };
}

export async function readResource(uri, params = {}, deps = {}) {
  switch (uri) {
    case "memory://stats": {
      const pool = getPrimaryPool();
      const stats = await pool.query(`
        SELECT
          type,
          ttl_tier,
          COUNT(*) as count,
          AVG(importance) as avg_importance,
          AVG(utility_score) as avg_utility
        FROM agent_memory.fragments
        GROUP BY type, ttl_tier
      `);
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(stats.rows, null, 2)
          }
        ]
      };
    }

    case "memory://topics": {
      const pool = getPrimaryPool();
      const topics = await pool.query(`
        SELECT DISTINCT topic
        FROM agent_memory.fragments
        ORDER BY topic ASC
      `);
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(topics.rows.map(r => r.topic), null, 2)
          }
        ]
      };
    }

    case "memory://config": {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(MEMORY_CONFIG, null, 2)
          }
        ]
      };
    }

    case "memory://active-session": {
      return readActiveSessionResource(params, deps);
    }

    default:
      throw new Error(`Unknown resource URI: ${uri}`);
  }
}
