import { MEMORY_CONFIG } from "../../config/memory.js";

const HEX_RE = /\b[0-9a-f]{8,}\b/iu;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
const RESOLUTION_CASCADE_RE = /\[\uBAA8\uC21C\s+\uD574\uACB0\]/gu;
const RESOLUTION_MARKER_RE = /^\[\uBAA8\uC21C\s+\uD574\uACB0\]/u;

function getConfig() {
  return MEMORY_CONFIG.noiseFilters || {};
}

function getRegexList(patterns = []) {
  return patterns
    .map((pattern) => {
      try {
        return new RegExp(pattern, "iu");
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function normalizeText(value) {
  return String(value || "").normalize("NFKC");
}

export function isSyntheticTopic(topic) {
  const normalized = normalizeText(topic).toLowerCase();
  if (!normalized) return false;

  return getRegexList(getConfig().syntheticTopicPatterns).some((regex) => regex.test(normalized));
}

export function isIdHeavyTopic(topic) {
  const normalized = normalizeText(topic).toLowerCase();
  if (!normalized) return false;

  return getRegexList(getConfig().idHeavyTopicPatterns).some((regex) => regex.test(normalized));
}

export function isDiffSummaryText(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return false;

  return getRegexList(getConfig().diffContentPatterns).some((regex) => regex.test(normalized));
}

export function hasHexLikeId(text) {
  const normalized = normalizeText(text).toLowerCase();
  return HEX_RE.test(normalized) || UUID_RE.test(normalized);
}

export function isResolutionCascadeText(text) {
  const normalized = normalizeText(text);
  const minRepeats = Number(getConfig().repeatedResolutionMin) || 2;
  const matches = normalized.match(RESOLUTION_CASCADE_RE) || [];
  return matches.length >= minRepeats;
}

export function hasResolutionMarkerText(text) {
  const normalized = normalizeText(text);
  return RESOLUTION_MARKER_RE.test(normalized);
}

export function isNoiseLikeFragment(fragment = {}) {
  const topic = normalizeText(fragment.topic);
  const content = normalizeText(fragment.content);
  const source = normalizeText(fragment.source);
  const combined = [topic, content, source].filter(Boolean).join("\n");

  if (!combined) return false;
  if (isSyntheticTopic(topic)) return true;

  const normalizedTopic = topic.toLowerCase();
  const hasDiff = isDiffSummaryText(combined);
  const hasId = hasHexLikeId(combined);
  const cascade = isResolutionCascadeText(combined);
  const idHeavyTopic = isIdHeavyTopic(topic);
  const resolutionMarker = hasResolutionMarkerText(content);

  if (normalizedTopic === "contradiction") return true;
  if (idHeavyTopic && resolutionMarker) return true;
  if (idHeavyTopic && hasDiff) return true;
  if (idHeavyTopic && hasId) return true;
  if (idHeavyTopic && cascade) return true;
  if (hasDiff && hasId) return true;
  if (cascade && (hasDiff || hasId)) return true;
  return false;
}

export function shouldSkipContradictionTracking(fragment = {}) {
  const topic = normalizeText(fragment.topic).toLowerCase();
  if (topic === "session_reflect") return true;
  return isNoiseLikeFragment(fragment);
}

export function isNoiseLikeToken(token, { sourceText = "" } = {}) {
  const cfg = getConfig();
  const normalized = normalizeText(token).toLowerCase().trim();
  if (!normalized) return true;

  const maxTokenLength = Number(cfg.maxTokenLength) || 40;
  const idTokenMinDigits = Number(cfg.idTokenMinDigits) || 4;
  const diffStopwords = new Set((cfg.diffStopwords || []).map((item) => String(item).toLowerCase()));

  if (normalized.length > maxTokenLength) return true;
  if (/^\d+$/u.test(normalized)) return true;
  if (HEX_RE.test(normalized) || UUID_RE.test(normalized)) return true;

  const digitCount = (normalized.match(/\d/g) || []).length;
  if (/^[a-z0-9_-]+$/u.test(normalized) && digitCount >= idTokenMinDigits) {
    return true;
  }

  if (isDiffSummaryText(sourceText) && diffStopwords.has(normalized)) {
    return true;
  }

  return false;
}

export function isNoiseLikeStoredMorpheme(token) {
  const cfg = getConfig();
  const normalized = normalizeText(token).toLowerCase().trim();
  const diffStopwords = new Set((cfg.diffStopwords || []).map((item) => String(item).toLowerCase()));

  if (!normalized) return true;
  if (diffStopwords.has(normalized)) return true;
  return isNoiseLikeToken(normalized);
}
