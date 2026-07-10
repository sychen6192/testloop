/**
 * Verdict 解析：fail-closed + 確定性計分。
 * - 六維 0-10 整數（對齊 skill rubric 的分數帶）。
 * - weighted_score 與 grade 由本函式依 skill 權重（25/20/15/15/15/10）與
 *   bands（A≥85 / B≥70 / C≥55 / D）計算——LLM 不算分（skill 原則 P1/P3）。
 * - 通過 = blockers 空 且 六維全數達門檻；advisories 與 grade 不影響判定。
 * - 任何解析失敗、缺欄位、分數超出範圍 → passed=false 附原因，絕不拋錯。
 */
import { REVIEW_DIMENSIONS, ReviewScores, ReviewVerdict } from "../libs/types";
import { SCORE_THRESHOLDS, ScoreThresholds, RUBRIC_WEIGHTS, GRADE_BANDS } from "../config";
import { tail } from "../libs/log";

export function computeWeighted(scores: ReviewScores): { weighted: number; grade: string } {
  let sum = 0;
  for (const d of REVIEW_DIMENSIONS) sum += scores[d] * RUBRIC_WEIGHTS[d];
  const weighted = Math.round(sum * 10 * 10) / 10; // Σ(score×weight)×10，保留一位小數
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
