/**
 * MorphemeIndex - 형태소 사전 관리 및 형태소 기반 임베딩 조회
 *
 * 작성자: 최진호
 * 작성일: 2026-03-10
 *
 * Gemini CLI로 텍스트를 형태소로 분리하고,
 * agent_memory.morpheme_dict 테이블에 형태소별 임베딩을 캐시한다.
 */

import { getPrimaryPool }                                          from "../tools/db.js";
import { generateEmbedding, vectorToSql, EMBEDDING_ENABLED }      from "../tools/embedding.js";
import { generateContent }                                        from "../gemini.js";
import { MEMORY_CONFIG }                                          from "../../config/memory.js";
import { logInfo, logWarn }                                       from "../logger.js";
import { isNoiseLikeFragment, isNoiseLikeToken }                  from "./NoiseFilters.js";

const SCHEMA = "agent_memory";

export class MorphemeIndex {

  /**
   * 텍스트를 형태소 목록으로 분리 (Gemini CLI)
   *
   * @param {string} text
   * @returns {Promise<string[]>} 형태소 목록 (기본형)
   */
  async tokenize(text) {
    const cfg     = MEMORY_CONFIG.morphemeIndex || {};
    const maxMorp = cfg.maxMorphemes || 10;
    if (isNoiseLikeFragment({ content: text })) {
      return [];
    }
    const fallbackTokens = this._fallbackTokenize(text, maxMorp);

    const prompt =
      `다음 텍스트를 한국어 형태소 분석하여 기본형 목록을 JSON 배열로 반환하라.\n` +
      `조사, 어미, 접속사, 대명사는 제외하고 명사·동사 원형·형용사 원형만 포함.\n` +
      `최대 ${maxMorp}개.\n\n` +
      `텍스트: "${text}"\n\n` +
      `JSON 배열만 출력 (설명 없이): ["형태소1", "형태소2", ...]`;

    try {
      const raw = await generateContent(prompt, {
        temperature: 0,
        maxTokens: 200,
        timeoutMs: cfg.geminiTimeoutMs,
        retryLimit: cfg.geminiRetryLimit,
        retryDelayMs: cfg.geminiRetryDelayMs
      });
      const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
      const result = JSON.parse(cleaned);
      if (!Array.isArray(result)) return fallbackTokens;
      const normalized = this._sanitizeTokens(result, text, maxMorp);
      if (normalized.length === 0) return fallbackTokens;
      return this._mergeTokens(normalized, fallbackTokens, maxMorp);
    } catch (err) {
      logWarn(`[MorphemeIndex] tokenize failed: ${err.message}`);
      return fallbackTokens;
    }
  }

  /**
   * Gemini 불가 시 단순 공백 분리 fallback
   */
  _fallbackTokenize(text, maxMorp = 10) {
    const stopwords = new Set(["이", "그", "저", "것", "수", "등", "및", "를", "을", "에",
      "의", "가", "는", "은", "도", "로", "와", "과", "한", "하", "함께",
      "대한", "관련", "현재", "지금", "정도", "경우", "사용", "기반",
      "the", "a", "an", "is", "are", "was", "were"]);
    const rawTokens = text.match(/[A-Za-z][A-Za-z0-9_-]*|[가-힣]{2,}/g) || [];
    const tokens = [];

    for (const rawToken of rawTokens) {
      const normalized = this._normalizeToken(rawToken, stopwords);
      if (!normalized || tokens.includes(normalized)) continue;
      if (isNoiseLikeToken(normalized, { sourceText: text })) continue;
      tokens.push(normalized);
      if (tokens.length >= maxMorp) break;
    }

    return tokens;
  }

  _normalizeToken(token, stopwords = new Set()) {
    let normalized = String(token || "")
      .trim()
      .toLowerCase()
      .normalize("NFKC")
      .replace(/^[^a-z0-9가-힣]+|[^a-z0-9가-힣]+$/g, "");

    if (!normalized) return "";

    if (/^[가-힣]+$/.test(normalized)) {
      normalized = this._stripKoreanSuffixes(normalized);
    }

    if (!normalized || normalized.length < 2) return "";
    if (stopwords.has(normalized)) return "";
    return normalized;
  }

  _stripKoreanSuffixes(token) {
    const suffixes = [
      "으로부터", "에게서는", "에게서", "까지는", "부터는", "으로는", "에서는", "에게는",
      "입니다", "습니다", "한다", "했다", "된다", "되고", "하는", "하다", "하며",
      "하고", "해서", "하여", "으로", "에서", "에게", "까지", "부터", "보다", "처럼",
      "만의", "이나", "나의", "랑", "와", "과", "의", "은", "는", "이", "가", "을", "를", "에", "도", "만", "로"
    ];

    for (const suffix of suffixes) {
      if (token.length - suffix.length < 1) continue;
      if (token.endsWith(suffix)) {
        return token.slice(0, -suffix.length);
      }
    }

    return token;
  }

  _sanitizeTokens(tokens, sourceText = "", maxMorp = 10) {
    const stopwords = new Set(["이", "그", "저", "것", "수", "등", "및", "를", "을", "에",
      "의", "가", "는", "은", "도", "로", "와", "과", "한", "하", "함께",
      "대한", "관련", "현재", "지금", "정도", "경우", "사용", "기반",
      "the", "a", "an", "is", "are", "was", "were"]);
    const sanitized = [];
    const normalizedSource = String(sourceText || "").toLowerCase().normalize("NFKC");

    for (const token of tokens) {
      const normalized = this._normalizeToken(token, stopwords);
      if (!normalized || sanitized.includes(normalized)) continue;
      if (/^[a-z0-9_-]+$/.test(normalized) && !normalizedSource.includes(normalized)) continue;
      if (isNoiseLikeToken(normalized, { sourceText })) continue;
      sanitized.push(normalized);
      if (sanitized.length >= maxMorp) break;
    }

    return sanitized;
  }

  _mergeTokens(primaryTokens, fallbackTokens, maxMorp = 10) {
    const merged = [];

    for (const token of [...primaryTokens, ...fallbackTokens]) {
      if (!token || merged.includes(token)) continue;
      merged.push(token);
      if (merged.length >= maxMorp) break;
    }

    return merged;
  }

  /**
   * 형태소 목록의 임베딩을 사전에서 조회
   * 사전에 없는 형태소는 임베딩 API로 생성 후 등록
   *
   * @param {string[]} morphemes
   * @returns {Promise<number[][]>} 임베딩 벡터 목록
   */
  async getOrRegisterEmbeddings(morphemes) {
    if (!EMBEDDING_ENABLED || morphemes.length === 0) return [];

    const pool = getPrimaryPool();
    if (!pool) return [];

    const placeholders = morphemes.map((_, i) => `$${i + 1}`).join(", ");
    const existing = await pool.query(
      `SELECT morpheme, embedding::text FROM ${SCHEMA}.morpheme_dict
       WHERE morpheme = ANY(ARRAY[${placeholders}])`,
      morphemes
    );

    const found   = new Map(existing.rows.map(r => [r.morpheme, r.embedding]));
    const missing = morphemes.filter(m => !found.has(m));

    /** 신규 형태소 임베딩 생성 및 등록 */
    for (const morpheme of missing) {
      try {
        const vec    = await generateEmbedding(morpheme);
        const vecStr = vectorToSql(vec);

        await pool.query(
          `INSERT INTO ${SCHEMA}.morpheme_dict (morpheme, embedding)
           VALUES ($1, $2::vector)
           ON CONFLICT (morpheme) DO NOTHING`,
          [morpheme, vecStr]
        );

        found.set(morpheme, vec);
        logInfo(`[MorphemeIndex] Registered morpheme: "${morpheme}"`);
      } catch (err) {
        logWarn(`[MorphemeIndex] embed failed for "${morpheme}": ${err.message}`);
      }
    }

    /** 조회 순서 유지하여 벡터 목록 반환 */
    const vectors = [];
    for (const m of morphemes) {
      const v = found.get(m);
      if (v) {
        vectors.push(typeof v === "string" ? JSON.parse(v) : v);
      }
    }

    return vectors;
  }

  /**
   * 벡터 목록의 평균 벡터 계산
   *
   * @param {number[][]} vectors
   * @returns {number[]|null}
   */
  averageVectors(vectors) {
    if (vectors.length === 0) return null;
    const dim = vectors[0].length;
    const sum = new Array(dim).fill(0);
    for (const v of vectors) {
      for (let i = 0; i < dim; i++) sum[i] += v[i];
    }
    return sum.map(x => x / vectors.length);
  }

  /**
   * 텍스트 → 형태소 분리 → 임베딩 평균 벡터 반환
   * remember() 시 비동기 형태소 등록에도 사용
   *
   * @param {string} text
   * @returns {Promise<number[]|null>}
   */
  async textToMorphemeVector(text) {
    const morphemes = await this.tokenize(text);
    if (morphemes.length === 0) return null;
    const vectors = await this.getOrRegisterEmbeddings(morphemes);
    return this.averageVectors(vectors);
  }
}
