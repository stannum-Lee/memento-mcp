/**
 * AutoReflect - session close automatic reflect orchestrator.
 *
 * SessionActivityTracker log data is summarized and fed into MemoryManager.reflect().
 * Gemini is preferred; when unavailable, a minimal fallback plus learning extraction is used.
 */

import { SessionActivityTracker } from "./SessionActivityTracker.js";
import { MemoryManager } from "./MemoryManager.js";
import { geminiCLIJson, isGeminiCLIAvailable } from "../gemini.js";
import { logDebug, logInfo, logWarn } from "../logger.js";
import { isNoiseLikeStoredMorpheme, isNoiseLikeToken } from "./NoiseFilters.js";

export const MIN_SESSION_DURATION_MS = 30_000;

export async function autoReflect(sessionId, agentId = "default") {
  if (!sessionId) return null;

  try {
    const activity = await SessionActivityTracker.getActivity(sessionId);
    if (!activity || activity.reflected) return null;

    if (_isEmptySession(activity)) {
      logDebug(`[AutoReflect] Skipping empty session: ${sessionId}`);
      await SessionActivityTracker.markReflected(sessionId);
      return { count: 0, fragments: [], skipped: true, reason: "empty_session" };
    }

    const mgr = MemoryManager.getInstance();
    if (process.env.AUTOREFLECT_DISABLE_GEMINI === "1") {
      return await _reflectMinimal(mgr, sessionId, agentId, activity);
    }
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
  const model = process.env.AUTOREFLECT_GEMINI_MODEL || process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";
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
생성/접근한 파편 수: ${fragCount}

다음 JSON 형식으로 응답하라:
{
  "summary": ["세션에서 수행한 작업을 1~2문장짜리 항목으로 쪼갠 배열. 항목 1개 = 사실 1건"],
  "decisions": ["결정 1건만 서술"],
  "errors_resolved": ["원인: X -> 해결: Y 형식으로 에러 1건만 서술"],
  "new_procedures": ["절차 1개만 서술"],
  "open_questions": ["미해결 질문 1건만 서술"],
  "narrative_summary": "이 세션에서 무슨 일이 있었는지 3~5문장의 서사로 작성. 사실 나열이 아니라 이야기로 써라."
}

Additionally, write a 'narrative_summary' field: a 3-5 sentence narrative of what happened in this session, why certain decisions were made, and what the outcome was. Write it as a story, not a list of facts.

중요 규칙:
- summary는 배열. 항목 1개 = 독립 사실 1건(1~2문장). 한 항목에 여러 사실 나열 금지.
- 모든 배열은 항목 1개 = 결정/에러/절차/질문 1건. 여러 내용을 한 항목에 나열 금지.
- 내용이 많으면 축약하지 말고 항목 수를 늘려라.
- 각 항목은 독립 파편으로 저장되므로 자체적으로 완결된 문장으로 작성하라.
- 세션 ID, fragment ID, hex/UUID, raw diff 통계(files changed/insertions/deletions), 내부 도구 호출 횟수 자체는 durable memory가 아니므로 쓰지 마라.
- 재사용 가능한 결정, 절차, 해결된 원인, 지속 선호만 우선 추출하라.
- 검색 패턴이나 도구 사용 패턴에서 학습할 수 있는 인사이트가 있다면 해당 항목 앞에 "LEARNING:" 접두사를 붙여라.
- 해당 사항이 없으면 빈 배열([])로 반환하라.
- summary는 반드시 포함하라.`;

  try {
    const result = await geminiCLIJson(prompt, { timeoutMs: 30_000, model });
    if (!Array.isArray(result?.summary) || result.summary.length === 0) {
      return await _reflectMinimal(mgr, sessionId, agentId, activity);
    }

    const reflectResult = await mgr.reflect({
      sessionId,
      agentId,
      summary: result.summary,
      decisions: result.decisions || [],
      errors_resolved: result.errors_resolved || [],
      new_procedures: result.new_procedures || [],
      open_questions: result.open_questions || [],
      narrative_summary: result.narrative_summary || null
    });

    if (reflectResult.fragments) {
      for (const item of reflectResult.fragments) {
        if (typeof item.content === "string" && item.content.startsWith("LEARNING:")) {
          item.source = "learning_extraction";
          item.content = item.content.replace(/^LEARNING:\s*/, "");
        }
      }
    }

    await SessionActivityTracker.markReflected(sessionId);
    logInfo(`[AutoReflect] Gemini-based reflect completed for ${sessionId}: ${reflectResult.count} fragments`);
    return reflectResult;
  } catch (err) {
    logWarn(`[AutoReflect] Gemini summarization failed, falling back to minimal: ${err.message}`);
    return await _reflectMinimal(mgr, sessionId, agentId, activity);
  }
}

async function _reflectMinimal(mgr, sessionId, agentId, activity) {
  const keywordSourceText = (activity.keywords || []).join(" ");
  const durableKeywords = (activity.keywords || [])
    .map((keyword) => String(keyword || "").trim())
    .filter(Boolean)
    .filter((keyword) => !isNoiseLikeToken(keyword, { sourceText: keywordSourceText }))
    .filter((keyword) => !isNoiseLikeStoredMorpheme(keyword))
    .slice(0, 5);

  let reflectResult = { fragments: [], count: 0, breakdown: {} };
  if (durableKeywords.length > 0) {
    reflectResult = await mgr.reflect({
      sessionId,
      agentId,
      summary: `최근 세션에서 ${durableKeywords.join(", ")} 관련 작업을 수행했다.`
    });
  }

  const learningFragments = await _extractLearningFragments(mgr, activity, agentId);
  if (learningFragments.length === 0 && durableKeywords.length === 0) {
    await SessionActivityTracker.markReflected(sessionId);
    logInfo(`[AutoReflect] Minimal reflect skipped for ${sessionId}: no durable keywords or learning signals`);
    return {
      fragments: [],
      count: 0,
      breakdown: { summary: 0, decisions: 0, errors: 0, procedures: 0, questions: 0, skipped: true }
    };
  }

  if (learningFragments.length > 0) {
    reflectResult.fragments = [...(reflectResult.fragments || []), ...learningFragments];
    reflectResult.count = (reflectResult.count || 0) + learningFragments.length;
  }

  await SessionActivityTracker.markReflected(sessionId);
  logInfo(`[AutoReflect] Minimal reflect completed for ${sessionId}: ${reflectResult.count} fragments`);
  return reflectResult;
}

async function _extractLearningFragments(mgr, activity, agentId) {
  const created = [];
  const searchPaths = activity.searchPaths || [];

  if (searchPaths.length >= 3) {
    const l3Count = searchPaths.filter((path) => String(path).includes("L3")).length;
    const l3Rate = l3Count / searchPaths.length;
    if (l3Rate > 0.5) {
      try {
        const learningFrag = await mgr.remember({
          content: `L3(시맨틱) 검색 비율 ${(l3Rate * 100).toFixed(0)}%: 키워드 정확도가 낮아 벡터 검색 의존도가 높았다. 키워드 품질 개선이 유효하다.`,
          topic: "search_pattern",
          type: "fact",
          importance: 0.4,
          source: "learning_extraction",
          agentId
        });
        created.push({ id: learningFrag.id, content: learningFrag.content, type: "fact", source: "learning_extraction" });
      } catch {
        // learning 생성 실패는 reflect 전체를 막지 않는다.
      }
    }

    const topTool = Object.entries(activity.toolCalls || {}).sort((a, b) => b[1] - a[1])[0];
    if (topTool && topTool[1] >= 5) {
      try {
        const toolLearning = await mgr.remember({
          content: `세션 내 ${topTool[0]} 도구를 ${topTool[1]}회 호출했다. 반복 패턴이 있으므로 자동화나 배치 처리로 줄일 여지가 있다.`,
          topic: "tool_pattern",
          type: "fact",
          importance: 0.4,
          source: "learning_extraction",
          agentId
        });
        created.push({ id: toolLearning.id, content: toolLearning.content, type: "fact", source: "learning_extraction" });
      } catch {
        // learning 생성 실패는 reflect 전체를 막지 않는다.
      }
    }
  }

  return created;
}

export function _isEmptySession(activity) {
  const hasNoToolCalls = !activity.toolCalls || Object.keys(activity.toolCalls).length === 0;
  const hasNoFragments = !activity.fragments || activity.fragments.length === 0;

  let isTooShort = false;
  if (activity.startedAt && activity.lastActivity) {
    const durationMs = new Date(activity.lastActivity) - new Date(activity.startedAt);
    isTooShort = durationMs < MIN_SESSION_DURATION_MS;
  } else {
    isTooShort = true;
  }

  return hasNoToolCalls || hasNoFragments || isTooShort;
}

function _calcDuration(startedAt, lastActivity) {
  if (!startedAt || !lastActivity) return "알 수 없음";

  const ms = new Date(lastActivity) - new Date(startedAt);
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "1분 미만";
  if (mins < 60) return `${mins}분`;

  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}시간 ${rem}분`;
}
