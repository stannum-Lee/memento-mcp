import { MEMORY_CONFIG } from "../../config/memory.js";
import {
  hasHexLikeId,
  isNoiseLikeFragment,
  isNoiseLikeStoredMorpheme,
  isSyntheticTopic,
  normalizeText
} from "./NoiseFilters.js";

export const MEMORY_QUALITY_REPORT_VERSION = "memory-quality-report.v1";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toLowerText(value) {
  return normalizeText(value).trim().toLowerCase();
}

function getDiffStopwordSet() {
  return new Set(
    (MEMORY_CONFIG.noiseFilters?.diffStopwords || []).map((token) => toLowerText(token))
  );
}

function isNumericOnlyToken(token) {
  return /^\d+$/u.test(toLowerText(token));
}

function isDiffStopwordToken(token) {
  return getDiffStopwordSet().has(toLowerText(token));
}

function sumCounts(rows = []) {
  return rows.reduce((total, row) => total + toFiniteNumber(row.count), 0);
}

function buildMaxCheck(name, actual, max, unit) {
  const numericMax = toFiniteNumber(max);
  const numericActual = toFiniteNumber(actual);
  const pass = numericActual <= numericMax;
  return {
    name,
    status: pass ? "pass" : "fail",
    actual: numericActual,
    expected: { max: numericMax, unit },
    message: pass
      ? `${name}: ${numericActual}${unit} <= ${numericMax}${unit}`
      : `${name}: ${numericActual}${unit} > ${numericMax}${unit}`
  };
}

function buildFractionCheck(name, actualCount, totalCount, maxFraction, minTotal) {
  const total = toFiniteNumber(totalCount);
  const count = toFiniteNumber(actualCount);
  const threshold = toFiniteNumber(maxFraction);
  const minimum = toFiniteNumber(minTotal);
  const actualFraction = total > 0 ? count / total : 0;

  if (total < minimum) {
    return {
      name,
      status: "info",
      actual: actualFraction,
      expected: { max: threshold, minTotal },
      message: `${name}: skipped ratio gate because total fragments ${total} < ${minimum}`
    };
  }

  const pass = actualFraction <= threshold;
  return {
    name,
    status: pass ? "pass" : "fail",
    actual: Number(actualFraction.toFixed(6)),
    expected: { max: threshold, minTotal },
    message: pass
      ? `${name}: ${actualFraction.toFixed(4)} <= ${threshold}`
      : `${name}: ${actualFraction.toFixed(4)} > ${threshold}`
  };
}

export function getMemoryQualityBudgets() {
  return cloneJson(MEMORY_CONFIG.qualityGuards || {});
}

export function collectMemoryQualityMetrics({
  fragments = [],
  morphemes = [],
  relationCounts = [],
  searchEventCount = 0,
  linkedFeedbackCount = 0
} = {}) {
  const fragmentRows = Array.isArray(fragments) ? fragments : [];
  const morphemeRows = Array.isArray(morphemes) ? morphemes : [];
  const sessionReflectFragments = fragmentRows.filter((fragment) => toLowerText(fragment.topic) === "session_reflect");
  const contradictionFragments = fragmentRows.filter((fragment) => toLowerText(fragment.topic) === "contradiction");
  const syntheticTopicFragments = fragmentRows.filter((fragment) => isSyntheticTopic(fragment.topic));
  const noisyFragments = fragmentRows.filter((fragment) => isNoiseLikeFragment(fragment));
  const noisySessionReflectFragments = sessionReflectFragments.filter((fragment) => isNoiseLikeFragment(fragment));

  const morphemeValues = morphemeRows.map((row) => normalizeText(row.morpheme).trim()).filter(Boolean);
  const noisyMorphemes = morphemeValues.filter((token) => isNoiseLikeStoredMorpheme(token));
  const hexLikeMorphemes = morphemeValues.filter((token) => hasHexLikeId(token));
  const numericOnlyMorphemes = morphemeValues.filter((token) => isNumericOnlyToken(token));
  const diffStopwordMorphemes = morphemeValues.filter((token) => isDiffStopwordToken(token));

  const relationRows = Array.isArray(relationCounts) ? relationCounts : [];
  const relationTotal = sumCounts(relationRows);
  const nonRetrievalRelationCount = sumCounts(
    relationRows.filter((row) => toLowerText(row.relation_type) !== "co_retrieved")
  );

  return {
    fragments: {
      total: fragmentRows.length,
      syntheticTopicCount: syntheticTopicFragments.length,
      contradictionTopicCount: contradictionFragments.length,
      noisyCount: noisyFragments.length,
      sessionReflectCount: sessionReflectFragments.length,
      noisySessionReflectCount: noisySessionReflectFragments.length,
      sessionReflectFraction:
        fragmentRows.length > 0 ? Number((sessionReflectFragments.length / fragmentRows.length).toFixed(6)) : 0
    },
    morphemes: {
      total: morphemeValues.length,
      noisyCount: noisyMorphemes.length,
      hexLikeCount: hexLikeMorphemes.length,
      numericOnlyCount: numericOnlyMorphemes.length,
      diffStopwordCount: diffStopwordMorphemes.length
    },
    relations: {
      total: relationTotal,
      nonRetrievalCount: nonRetrievalRelationCount
    },
    observability: {
      searchEventCount: toFiniteNumber(searchEventCount),
      linkedFeedbackCount: toFiniteNumber(linkedFeedbackCount)
    }
  };
}

export function buildMemoryQualityReport(input = {}) {
  const budgets = getMemoryQualityBudgets();
  const metrics = collectMemoryQualityMetrics(input);
  const checks = [];

  checks.push(
    buildMaxCheck(
      "synthetic-topic-fragments",
      metrics.fragments.syntheticTopicCount,
      budgets.syntheticTopicFragments?.maxAbsolute ?? 0,
      " fragments"
    )
  );
  checks.push(
    buildMaxCheck(
      "contradiction-topic-fragments",
      metrics.fragments.contradictionTopicCount,
      budgets.contradictionFragments?.maxAbsolute ?? 0,
      " fragments"
    )
  );
  checks.push(
    buildMaxCheck(
      "noisy-fragments",
      metrics.fragments.noisyCount,
      budgets.noisyFragments?.maxAbsolute ?? 0,
      " fragments"
    )
  );
  checks.push(
    buildMaxCheck(
      "session-reflect-fragments",
      metrics.fragments.sessionReflectCount,
      budgets.sessionReflect?.maxAbsolute ?? 0,
      " fragments"
    )
  );
  checks.push(
    buildMaxCheck(
      "noisy-session-reflect-fragments",
      metrics.fragments.noisySessionReflectCount,
      budgets.sessionReflect?.maxNoisyCount ?? 0,
      " fragments"
    )
  );
  checks.push(
    buildFractionCheck(
      "session-reflect-fragment-share",
      metrics.fragments.sessionReflectCount,
      metrics.fragments.total,
      budgets.sessionReflect?.maxFractionOfFragments ?? 0,
      budgets.sessionReflect?.minFragmentsForFraction ?? 0
    )
  );
  checks.push(
    buildMaxCheck(
      "noisy-morphemes",
      metrics.morphemes.noisyCount,
      budgets.morphemes?.maxNoisyCount ?? 0,
      " morphemes"
    )
  );
  checks.push(
    buildMaxCheck(
      "hex-like-morphemes",
      metrics.morphemes.hexLikeCount,
      budgets.morphemes?.maxHexLikeCount ?? 0,
      " morphemes"
    )
  );
  checks.push(
    buildMaxCheck(
      "numeric-only-morphemes",
      metrics.morphemes.numericOnlyCount,
      budgets.morphemes?.maxNumericOnlyCount ?? 0,
      " morphemes"
    )
  );
  checks.push(
    buildMaxCheck(
      "diff-stopword-morphemes",
      metrics.morphemes.diffStopwordCount,
      budgets.morphemes?.maxDiffStopwordCount ?? 0,
      " morphemes"
    )
  );

  checks.push({
    name: "relation-adoption",
    status: "info",
    actual: metrics.relations.nonRetrievalCount,
    expected: { min: 0 },
    message: `relation-adoption: ${metrics.relations.nonRetrievalCount} non-retrieval links across ${metrics.relations.total} total links`
  });
  checks.push({
    name: "search-observability",
    status: "info",
    actual: metrics.observability.searchEventCount,
    expected: { min: 0 },
    message: `search-observability: ${metrics.observability.searchEventCount} search_events, ${metrics.observability.linkedFeedbackCount} linked tool_feedback rows`
  });

  const failed = checks.filter((check) => check.status === "fail");
  return {
    version: MEMORY_QUALITY_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    budgets,
    metrics,
    checks,
    outcome: failed.length > 0 ? "fail" : "pass"
  };
}
