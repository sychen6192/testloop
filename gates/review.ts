// Review gate: run the read-only reviewer, then fail-closed parsing + deterministic scoring.
// Six 0-10 integer dims (per the skill rubric bands).
// weighted_score and grade are computed here from skill weights (25/20/15/15/15/10)
// and bands (A>=85 / B>=70 / C>=55 / D) — the LLM never scores.
// Pass = blockers empty AND all six dims meet threshold; advisories/grade don't affect it.
// Any parse failure, missing field, or out-of-range score -> passed=false with a reason, never throws.
import {
  AgentRunner,
  REVIEW_DIMENSIONS,
  ReviewScores,
  ReviewVerdict,
} from "../libs/types";
import {
  SCORE_THRESHOLDS,
  ScoreThresholds,
  RUBRIC_WEIGHTS,
  GRADE_BANDS,
  REVIEWER_MUST_READ,
} from "../config";
import { tail } from "../libs/log";

export function computeWeighted(scores: ReviewScores): { weighted: number; grade: string } {
  let sum = 0;
  for (const d of REVIEW_DIMENSIONS) sum += scores[d] * RUBRIC_WEIGHTS[d];
  const weighted = Math.round(sum * 10 * 10) / 10; // Σ(score×weight)×10, one decimal
  const grade = GRADE_BANDS.find((b) => weighted >= b.min)?.grade ?? "D";
  return { weighted, grade };
}

export function parseVerdict(
  raw: string,
  thresholds: ScoreThresholds = SCORE_THRESHOLDS,
): ReviewVerdict {
  const failed = (why: string): ReviewVerdict => ({
    passed: false,
    scores: {},
    blockers: [
      `Reviewer 輸出無法解析（${why}），依 fail-closed 原則判 REJECT。` +
        `請重新輸出符合 schema 的單一 JSON 物件。原文節錄：${tail(raw, 800)}`,
    ],
    advisories: [],
    belowThreshold: [],
    parseError: why,
    raw,
  });

  const cleaned = raw.replace(/```json|```/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return failed("找不到 JSON 物件");

  let obj: unknown;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    return failed(`JSON.parse 失敗：${e instanceof Error ? e.message : String(e)}`);
  }
  const o = obj as Record<string, unknown>;
  const rawScores = (o.scores ?? {}) as Record<string, unknown>;

  const scores = {} as ReviewScores;
  const belowThreshold: string[] = [];
  for (const d of REVIEW_DIMENSIONS) {
    const v = Number(rawScores[d]);
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > 10) {
      return failed(`維度 ${d} 分數缺漏或超出 0-10 整數`);
    }
    scores[d] = v;
    const th = thresholds[d];
    if (v < th) belowThreshold.push(`${d}（${v} < 門檻 ${th}）`);
  }

  if (!Array.isArray(o.blockers)) return failed("缺 blockers 陣列");
  const blockers = (o.blockers as unknown[]).map(String);
  const advisories = Array.isArray(o.advisories)
    ? (o.advisories as unknown[]).map(String)
    : [];

  const { weighted, grade } = computeWeighted(scores);
  const passed = blockers.length === 0 && belowThreshold.length === 0;
  return { passed, scores, blockers, advisories, belowThreshold, weightedScore: weighted, grade, raw };
}

// Fail-closed: a verdict produced without a single tool call means the reviewer read nothing
// (observed failure mode: schema-valid verdicts with fabricated findings).
export function zeroToolCallVerdict(raw: string): ReviewVerdict {
  return {
    passed: false,
    scores: {},
    blockers: [
      "Reviewer 未呼叫任何工具即輸出判決（tool calls = 0），視同未實際讀取測試檔，" +
        "依 fail-closed 原則判 REJECT。此屬 reviewer 模型行為異常：請考慮更換 " +
        "UT_REVIEWER_MODEL 或改善 provider 設定（確定要放行可設 UT_REVIEWER_MUST_READ=0）。",
    ],
    advisories: [],
    belowThreshold: [],
    parseError: "reviewer 0 tool calls",
    raw,
  };
}

export async function runReviewGate(
  runner: AgentRunner,
  prompt: string,
): Promise<ReviewVerdict> {
  const out = await runner.runReview(prompt);
  if (REVIEWER_MUST_READ && out.toolCallCount === 0) return zeroToolCallVerdict(out.text);
  return parseVerdict(out.text);
}
