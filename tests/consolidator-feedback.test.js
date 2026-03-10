import { applyFeedbackSignal } from "../lib/memory/MemoryConsolidator.js";

describe("applyFeedbackSignal", () => {
    it("sufficient=true, relevant=true → importance 상승", () => {
        const result = applyFeedbackSignal(0.5, true, true);
        expect(result).toBeGreaterThan(0.5);
    });

    it("relevant=false → importance 하락", () => {
        const result = applyFeedbackSignal(0.5, false, false);
        expect(result).toBeLessThan(0.5);
    });

    it("relevant=true, sufficient=false → 소폭 하락", () => {
        const result = applyFeedbackSignal(0.5, true, false);
        expect(result).toBeLessThan(0.5);
        expect(result).toBeGreaterThan(0.4);
    });

    it("결과는 항상 [0.05, 1.0] 범위 내", () => {
        expect(applyFeedbackSignal(0.99, true, true)).toBeLessThanOrEqual(1.0);
        expect(applyFeedbackSignal(0.06, false, false)).toBeGreaterThanOrEqual(0.05);
    });
});
