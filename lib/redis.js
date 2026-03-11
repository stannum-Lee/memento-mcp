/**
 * Redis ?대씪?댁뼵???ㅼ젙
 *
 * ?묒꽦?? 理쒖쭊??
 * ?묒꽦?? 2026-02-13
 * ?섏젙?? 2026-02-13 (Phase 3: Redis Sentinel 吏??異붽?)
 *
 * 湲곕뒫:
 * - ?몄뀡 ??μ냼
 * - OAuth ?좏겙 ??μ냼
 * - 罹먯떛 ?덉씠??
 * - TTL 愿由?
 * - Redis Sentinel 怨좉??⑹꽦 (Phase 3)
 */

import Redis from "ioredis";
import { logInfo, logWarn, logError } from "./logger.js";
import {
  REDIS_ENABLED,
  REDIS_SENTINEL_ENABLED,
  REDIS_HOST,
  REDIS_PORT,
  REDIS_PASSWORD,
  REDIS_DB,
  REDIS_MASTER_NAME,
  REDIS_SENTINELS
} from "./config.js";

/**
 * REDIS_ENABLED != "true" ??
 * ?ㅼ젣 ?곌껐 ?놁씠 no-op 硫붿꽌?쒕? 諛섑솚?섎뒗 stub ?대씪?댁뼵??
 */
function createStubClient() {
  const noop   = async () => null;
  const noopOk = async () => "OK";
  const noopArray = async () => [];
  const noopHash = async () => ({});
  const noopScan = async () => ["0", []];
  const createPipeline = () => {
    const pipeline = {
      sadd: () => pipeline,
      srem: () => pipeline,
      zadd: () => pipeline,
      zrem: () => pipeline,
      del: () => pipeline,
      expire: () => pipeline,
      rpush: () => pipeline,
      scard: () => pipeline,
      exec: async () => []
    };
    return pipeline;
  };
  return {
    status: "stub",
    get: noop, set: noopOk, setex: noopOk, del: noop,
    lpush: noop, rpush: noop, rpop: noop, lpop: noop,
    lrange: noopArray, hgetall: noopHash,
    keys: noopArray, scan: noopScan,
    smembers: noopArray, sinter: noopArray, sunion: noopArray,
    srandmember: noopArray, zrevrange: noopArray,
    expire: noop, ping: noopOk, pipeline: createPipeline,
    quit: noop, disconnect: noop,
    on: () => {},
    once: () => {}, removeListener: () => {},
  };
}

/**
 * Redis ?대씪?댁뼵???앹꽦
 * - Sentinel ?쒖꽦???? Sentinel ?곌껐
 * - ?⑥씪 紐⑤뱶: 吏곸젒 ?곌껐
 */
function createRedisClient() {
  const forceRealRedisInTests = process.env.MEMENTO_TEST_USE_REDIS === "true";
  const isTestEnv = !!process.env.JEST_WORKER_ID || process.env.NODE_ENV === "test";

  if (isTestEnv && !forceRealRedisInTests) {
    logInfo("Redis disabled in test environment -- using stub client");
    return createStubClient();
  }

  if (!REDIS_ENABLED) {
    logInfo("Redis disabled (REDIS_ENABLED != true) ??using stub client");
    return createStubClient();
  }
  const commonOptions = {
    password       : REDIS_PASSWORD,
    db             : REDIS_DB,
    retryStrategy  : (times) => {
      const delay    = Math.min(times * 50, 2000);
      logWarn(`Redis reconnecting (attempt ${times}), delay ${delay}ms`);
      return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck    : true,
    lazyConnect         : false
  };

  if (REDIS_SENTINEL_ENABLED) {
    // Redis Sentinel 紐⑤뱶
    logInfo("Initializing Redis with Sentinel", {
      masterName: REDIS_MASTER_NAME,
      sentinels : REDIS_SENTINELS
    });

    return new Redis({
      sentinels: REDIS_SENTINELS,
      name     : REDIS_MASTER_NAME,
      ...commonOptions
    });
  } else {
    // ?⑥씪 Redis 紐⑤뱶
    logInfo("Initializing Redis in standalone mode", {
      host: REDIS_HOST,
      port: REDIS_PORT
    });

    return new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      ...commonOptions
    });
  }
}

/** Redis ?대씪?댁뼵??*/
export const redisClient = createRedisClient();

/** ?대깽???몃뱾??*/
redisClient.on("connect", () => {
  logInfo("Redis client connected", {
    host: REDIS_HOST,
    port: REDIS_PORT,
    db  : REDIS_DB
  });
});

redisClient.on("ready", () => {
  logInfo("Redis client ready");
});

redisClient.on("error", (err) => {
  logError("Redis client error", err, {
    host: REDIS_HOST,
    port: REDIS_PORT
  });
});

redisClient.on("close", () => {
  logWarn("Redis client connection closed");
});

redisClient.on("reconnecting", () => {
  logInfo("Redis client reconnecting...");
});

/**
 * Redis ?ъ뒪 泥댄겕
 */
export async function checkRedisHealth() {
  try {
    await redisClient.ping();
    return { healthy: true, message: "Redis is healthy" };
  } catch (err) {
    logError("Redis health check failed", err);
    return { healthy: false, message: err.message };
  }
}

/**
 * ?몄뀡 ???앹꽦
 */
export function getSessionKey(sessionId) {
  return `session:${sessionId}`;
}

/**
 * OAuth 肄붾뱶 ???앹꽦
 */
export function getOAuthCodeKey(code) {
  return `oauth:code:${code}`;
}

/**
 * OAuth ?좏겙 ???앹꽦
 */
export function getOAuthTokenKey(token) {
  return `oauth:token:${token}`;
}

/**
 * 臾몄꽌 罹먯떆 ???앹꽦
 */
export function getDocCacheKey(path) {
  return `cache:doc:${path}`;
}

/**
 * DB 荑쇰━ 罹먯떆 ???앹꽦
 */
export function getDbCacheKey(sql, params = []) {
  const hash = Buffer.from(`${sql}:${JSON.stringify(params)}`).toString("base64");
  return `cache:db:${hash}`;
}

/**
 * ?몄뀡 ???(TTL ?ы븿)
 */
export async function saveSession(sessionId, sessionData, ttlSeconds) {
  try {
    const key      = getSessionKey(sessionId);
    const value    = JSON.stringify(sessionData);

    await redisClient.setex(key, ttlSeconds, value);

    logInfo("Session saved to Redis", {
      sessionId: sessionId.substring(0, 8),
      ttl      : ttlSeconds
    });

    return true;
  } catch (err) {
    logError("Failed to save session to Redis", err, { sessionId });
    return false;
  }
}

/**
 * ?몄뀡 議고쉶
 */
export async function getSession(sessionId) {
  try {
    const key      = getSessionKey(sessionId);
    const value    = await redisClient.get(key);

    if (!value) {
      return null;
    }

    return JSON.parse(value);
  } catch (err) {
    logError("Failed to get session from Redis", err, { sessionId });
    return null;
  }
}

/**
 * ?몄뀡 ??젣
 */
export async function deleteSession(sessionId) {
  try {
    const key      = getSessionKey(sessionId);
    await redisClient.del(key);

    logInfo("Session deleted from Redis", {
      sessionId: sessionId.substring(0, 8)
    });

    return true;
  } catch (err) {
    logError("Failed to delete session from Redis", err, { sessionId });
    return false;
  }
}

/**
 * ?몄뀡 TTL ?곗옣
 */
export async function extendSessionTTL(sessionId, ttlSeconds) {
  try {
    const key      = getSessionKey(sessionId);
    await redisClient.expire(key, ttlSeconds);

    return true;
  } catch (err) {
    logError("Failed to extend session TTL", err, { sessionId });
    return false;
  }
}

/**
 * OAuth 肄붾뱶 ???
 */
export async function saveOAuthCode(code, codeData, ttlSeconds = 600) {
  try {
    const key      = getOAuthCodeKey(code);
    const value    = JSON.stringify(codeData);

    await redisClient.setex(key, ttlSeconds, value);

    return true;
  } catch (err) {
    logError("Failed to save OAuth code to Redis", err);
    return false;
  }
}

/**
 * OAuth 肄붾뱶 議고쉶 諛???젣 (?쇳쉶??
 */
export async function consumeOAuthCode(code) {
  try {
    const key      = getOAuthCodeKey(code);
    const value    = await redisClient.get(key);

    if (!value) {
      return null;
    }

    // ?ъ슜 利됱떆 ??젣 (?쇳쉶??
    await redisClient.del(key);

    return JSON.parse(value);
  } catch (err) {
    logError("Failed to consume OAuth code from Redis", err);
    return null;
  }
}

/**
 * OAuth ?≪꽭???좏겙 ???
 */
export async function saveOAuthToken(token, tokenData, ttlSeconds = 3600) {
  try {
    const key      = getOAuthTokenKey(token);
    const value    = JSON.stringify(tokenData);

    await redisClient.setex(key, ttlSeconds, value);

    return true;
  } catch (err) {
    logError("Failed to save OAuth token to Redis", err);
    return false;
  }
}

/**
 * OAuth ?≪꽭???좏겙 議고쉶
 */
export async function getOAuthToken(token) {
  try {
    const key      = getOAuthTokenKey(token);
    const value    = await redisClient.get(key);

    if (!value) {
      return null;
    }

    return JSON.parse(value);
  } catch (err) {
    logError("Failed to get OAuth token from Redis", err);
    return null;
  }
}

/**
 * OAuth ?≪꽭???좏겙 ??젣
 */
export async function deleteOAuthToken(token) {
  try {
    const key      = getOAuthTokenKey(token);
    await redisClient.del(key);

    return true;
  } catch (err) {
    logError("Failed to delete OAuth token from Redis", err);
    return false;
  }
}

/**
 * 臾몄꽌 罹먯떆 ???
 */
export async function cacheDocument(path, content, ttlSeconds = 3600) {
  try {
    const key      = getDocCacheKey(path);
    const value    = JSON.stringify({ content, cachedAt: Date.now() });

    await redisClient.setex(key, ttlSeconds, value);

    return true;
  } catch (err) {
    logError("Failed to cache document", err, { path });
    return false;
  }
}

/**
 * 臾몄꽌 罹먯떆 議고쉶
 */
export async function getCachedDocument(path) {
  try {
    const key      = getDocCacheKey(path);
    const value    = await redisClient.get(key);

    if (!value) {
      return null;
    }

    const data     = JSON.parse(value);

    return data.content;
  } catch (err) {
    logError("Failed to get cached document", err, { path });
    return null;
  }
}

/**
 * 臾몄꽌 罹먯떆 臾댄슚??
 */
export async function invalidateDocumentCache(path) {
  try {
    const key      = getDocCacheKey(path);
    await redisClient.del(key);

    logInfo("Document cache invalidated", { path });

    return true;
  } catch (err) {
    logError("Failed to invalidate document cache", err, { path });
    return false;
  }
}

/**
 * DB 荑쇰━ 寃곌낵 罹먯떆
 */
export async function cacheDbQuery(sql, params, result, ttlSeconds = 300) {
  try {
    const key      = getDbCacheKey(sql, params);
    const value    = JSON.stringify({ result, cachedAt: Date.now() });

    await redisClient.setex(key, ttlSeconds, value);

    return true;
  } catch (err) {
    logError("Failed to cache DB query", err);
    return false;
  }
}

/**
 * DB 荑쇰━ 罹먯떆 議고쉶
 */
export async function getCachedDbQuery(sql, params) {
  try {
    const key      = getDbCacheKey(sql, params);
    const value    = await redisClient.get(key);

    if (!value) {
      return null;
    }

    const data     = JSON.parse(value);

    return data.result;
  } catch (err) {
    logError("Failed to get cached DB query", err);
    return null;
  }
}

/**
 * ?꾩껜 罹먯떆 臾댄슚??(?⑦꽩 湲곕컲)
 */
export async function invalidateCacheByPattern(pattern) {
  try {
    const keys     = await redisClient.keys(pattern);

    if (keys.length > 0) {
      await redisClient.del(...keys);
      logInfo(`Cache invalidated: ${keys.length} keys deleted`, { pattern });
    }

    return keys.length;
  } catch (err) {
    logError("Failed to invalidate cache by pattern", err, { pattern });
    return 0;
  }
}

/**
 * ?먯뿉 ?묒뾽 異붽? (LPUSH)
 */
export async function pushToQueue(queueName, data) {
  try {
    const key   = `queue:${queueName}`;
    const value = JSON.stringify({ ...data, queuedAt: Date.now() });
    await redisClient.lpush(key, value);
    return true;
  } catch (err) {
    logError(`Failed to push to queue ${queueName}`, err);
    return false;
  }
}

/**
 * 큐 우선순위 삽입 (RPUSH - rpop이 즉시 꺼냄)
 *
 * EmbeddingWorker는 rpop으로 꺼내므로 rpush로 넣으면 다음 배치에서 가장 먼저 처리된다.
 * reflect() 직후처럼 임베딩이 즉시 필요한 파편에 사용.
 */
export async function pushToQueuePriority(queueName, data) {
  try {
    const key   = `queue:${queueName}`;
    const value = JSON.stringify({ ...data, queuedAt: Date.now(), priority: true });
    await redisClient.rpush(key, value);
    return true;
  } catch (err) {
    logError(`Failed to priority-push to queue ${queueName}`, err);
    return false;
  }
}

/**
 * 큐에서 작업 꺼내기 (RPOP)
 */
export async function popFromQueue(queueName) {
  try {
    const key   = `queue:${queueName}`;
    const value = await redisClient.rpop(key);
    return value ? JSON.parse(value) : null;
  } catch (err) {
    logError(`Failed to pop from queue ${queueName}`, err);
    return null;
  }
}

/**
 * Redis ?곌껐 醫낅즺
 */
export async function closeRedis() {
  try {
    await redisClient.quit();
    logInfo("Redis connection closed");
  } catch (err) {
    logError("Failed to close Redis connection", err);
  }
}

/**
 * Redis ?곌껐 珥덇린??(紐⑤뱢 濡쒕뱶 ???먮룞 ?곌껐?섎?濡?ready ?곹깭 ?뺤씤留??섑뻾)
 */
export async function connectRedis() {
  /** ioredis???앹꽦 利됱떆 ?곌껐???쒕룄?섎?濡?蹂꾨룄 connect() ?몄텧 遺덊븘??*/
}

/**
 * Redis ?곌껐 醫낅즺 (closeRedis 蹂꾩묶)
 */
export const disconnectRedis = closeRedis;

export default redisClient;

