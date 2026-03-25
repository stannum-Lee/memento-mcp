/**
 * AutoReflect - session close automatic reflect orchestrator.
 *
 * SessionActivityTracker log data is summarized and fed into MemoryManager.reflect().
 * Gemini CLI is preferred; when unavailable, a minimal fallback is used.
 */

import { SessionActivityTracker } from "./SessionActivityTracker.js";
import { MemoryManager } from "./MemoryManager.js";
import { geminiCLIJson, isGeminiCLIAvailable } from "../gemini.js";
import { logInfo, logWarn } from "../logger.js";
import { isNoiseLikeToken } from "./NoiseFilters.js";

/**
 * Run automatic reflect for a session.
 *
 * @param {string} sessionId
 * @param {string} [agentId="default"]
 * @returns {Promise<Object|null>}
 */
export async function autoReflect(sessionId, agentId = "default") {
  if (!sessionId) return null;

  try {
    const activity = await SessionActivityTracker.getActivity(sessionId);

    if (!activity || activity.reflected) return null;

    if (!activity.toolCalls || Object.keys(activity.toolCalls).length === 0) {
      await SessionActivityTracker.markReflected(sessionId);
      return null;
    }

    const mgr = MemoryManager.getInstance();

    if (await isGeminiCLIAvailable()) {
      return await _reflectWithGemini(mgr, sessionId, agentId, activity);
    }

    return await _reflectMinimal(mgr, sessionId, agentId, activity);
  } catch (err) {
    logWarn(`[AutoReflect] Failed for session ${sessionId}: ${err.message}`);
    return null;
  }
}

async function _reflectWithGemini(mgr, sessionId, agentId, activity) {
  const toolSummary = Object.entries(activity.toolCalls || {})
    .map(([tool, count]) => `${tool}: ${count}회`)
    .join(", ");

  const kwList = (activity.keywords || []).slice(0, 20).join(", ");
  const fragCount = (activity.fragments || []).length;
  const duration = _calcDuration(activity.startedAt, activity.lastActivity);

  const prompt = `다음 AI 에이전트 세션 활동 로그를 분석하여 구조화된 기억 파편을 생성하라.

세션 ID: ${sessionId}
소요 시간: ${duration}
도구 사용: ${toolSummary}
검색 키워드: ${kwList || "없음"}
생성/수정한 파편 수: ${fragCount}

다음 JSON 형식으로만 응답하라:
{
  "summary": ["세션에서 수행한 작업을 1~2문장짜리 항목으로 쪼갠 배열. 항목 1개 = 사실 1건"],
  "decisions": ["결정 1건만 서술"],
  "errors_resolved": ["원인: X -> 해결: Y 형식으로 에러 1건만 서술"],
  "new_procedures": ["절차 1개만 서술"],
  "open_questions": ["미해결 질문 1건만 서술"]
}

중요 규칙:
- summary는 배열. 항목 1개 = 독립 사실 1건(1~2문장). 한 항목에 여러 사실 나열 금지.
- 모든 배열은 항목 1개 = 결정/에러/절차/질문 1건. 여러 내용을 한 항목에 나열 금지.
- 내용이 많으면 축약하지 말고 항목 수를 늘려라.
- 각 항목은 독립 파편으로 저장되므로 자체적으로 완결된 문장으로 작성하라.
- 세션 ID, fragment ID, hex/UUID, raw diff 통계(files changed/insertions/deletions), 내부 도구 호출 횟수 자체는 durable memory가 아니므로 기본적으로 쓰지 마라.
- 재사용 가능한 결정, 절차, 해결된 원인, 지속 선호만 우선 추출하라.
- 해당 사항이 없으면 빈 배열([])로 반환하라.
- summary는 반드시 포함하라.`;

  try {
    const result = await geminiCLIJson(prompt, { timeoutMs: 30_000 });

    if (!result.summary) {
      return await _reflectMinimal(mgr, sessionId, agentId, activity);
    }

    const reflectResult = await mgr.reflect({
      sessionId,
      agentId,
      summary: result.summary,
      decisions: result.decisions || [],
      errors_resolved: result.errors_resolved || [],
      new_procedures: result.new_procedures || [],
      open_questions: result.open_questions || []
    });

    await SessionActivityTracker.markReflected(sessionId);
    logInfo(`[AutoReflect] Gemini-based reflect completed for ${sessionId}: ${reflectResult.count} fragments`);
    return reflectResult;
  } catch (err) {
    logWarn(`[AutoReflect] Gemini summarization failed, falling back to minimal: ${err.message}`);
    return await _reflectMinimal(mgr, sessionId, agentId, activity);
  }
}

async function _reflectMinimal(mgr, sessionId, agentId, activity) {
  const durableKeywords = (activity.keywords || [])
    .map((keyword) => String(keyword || "").trim())
    .filter(Boolean)
    .filter((keyword) => !isNoiseLikeToken(keyword))
    .slice(0, 5);

  if (durableKeywords.length === 0) {
    await SessionActivityTracker.markReflected(sessionId);
    logInfo(`[AutoReflect] Minimal reflect skipped for ${sessionId}: no durable keywords`);
    return {
      fragments: [],
      count: 0,
      breakdown: { summary: 0, decisions: 0, errors: 0, procedures: 0, questions: 0, skipped: true }
    };
  }

  const summary = `최근 세션에서 ${durableKeywords.join(", ")} 관련 작업을 수행했다.`;

  const reflectResult = await mgr.reflect({
    sessionId,
    agentId,
    summary
  });

  await SessionActivityTracker.markReflected(sessionId);
  logInfo(`[AutoReflect] Minimal reflect completed for ${sessionId}: ${reflectResult.count} fragments`);
  return reflectResult;
}

function _calcDuration(startedAt, lastActivity) {
  if (!startedAt || !lastActivity) return "정보 없음";

  const ms = new Date(lastActivity) - new Date(startedAt);
  const mins = Math.floor(ms / 60000);

  if (mins < 1) return "1분 미만";
  if (mins < 60) return `${mins}분`;

  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}시간 ${rem}분`;
}
