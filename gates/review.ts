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

/**
 * Pure: every balanced top-level {...} in the reviewer's text, in order.
 *
 * The verdict used to be the span from the first "{" to the last "}". Reasoning models served
 * without a reasoning parser (Qwen3, QwQ, R1 distills) put their thinking in content — prose
 * about Java code, full of braces — and a reviewer may show a draft before the final object or
 * add a note after it. Every one of those parsed as garbage, identically on each retry at
 * temperature 0, and the run ended as reviewer-unparseable although a valid verdict was there.
 * The thinking is dropped (Qwen3's template opens <think> in the prompt, so only the closing tag
 * may appear), and braces inside JSON strings do not count.
 */
export function jsonObjectCandidates(raw: string): string[] {
  const text = replyText(raw);
  return objectSpans(text).map(([a, b]) => text.slice(a, b));
}

/** The reply with thinking and code fences removed — what both scans below look at. */
function replyText(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const closeAt = text.lastIndexOf("</think>");
  if (closeAt >= 0) text = text.slice(closeAt + "</think>".length);
  return text.replace(/```json|```/g, "");
}

/** Pure: [start, end) of the balanced top-level {...} in `text` from `from` on, in order. */
function objectSpans(text: string, from = 0, max = Infinity): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = from; i < text.length && out.length < max; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"' && depth > 0) inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0 && --depth === 0) out.push([start, i + 1]);
  }
  return out;
}

/**
 * Pure: every object carrying `scores` that parses from some "{" outside all balanced top-level
 * objects (bounded). That region is only non-empty past an unclosed "{" in the prose. A "{"
 * inside a balanced object is never a starting point: a verdict nested in a wrapper that also
 * carries blockers would otherwise be taken on its own and pass with the wrapper's blockers
 * dropped.
 */
function scoredObjectsFromAnyBrace(raw: string): unknown[] {
  const text = replyText(raw);
  const spans = objectSpans(text);
  const inside = (i: number) => spans.some(([a, b]) => i > a && i < b);
  const out: unknown[] = [];
  let tries = 0;
  for (let i = text.indexOf("{"); i >= 0 && tries < 2000; i = text.indexOf("{", i + 1), tries++) {
    if (inside(i)) continue;
    const [first] = objectSpans(text, i, 1).map(([a, b]) => text.slice(a, b));
    if (!first || !first.includes('"scores"')) continue;
    try {
      const v: unknown = JSON.parse(first);
      if (v && typeof v === "object" && "scores" in (v as object)) out.push(v);
    } catch {
      /* not this one */
    }
  }
  return out;
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

  const candidates = jsonObjectCandidates(raw);
  // The verdict is the one object that parses and carries `scores`. Two that differ — a draft and
  // a final answer, one verdict per test file, an array of them — are ambiguous, and picking
  // either could drop a blocker the other one raised: fail closed, and the reviewer is retried.
  // Without any scored object, the last one that parses stands in, and the field checks below
  // say what is missing.
  const parsed: unknown[] = [];
  let lastErr = "";
  for (const c of candidates) {
    try {
      parsed.push(JSON.parse(c));
    } catch (e) {
      lastErr ||= e instanceof Error ? e.message : String(e);
    }
  }
  let scored = parsed.filter((v) => v && typeof v === "object" && "scores" in (v as object));
  // One unbalanced "{" in the prose before the verdict ("`void save() {` asserts nothing") keeps
  // the scan above at depth > 0 for the rest of the text, and the verdict is never seen — the same
  // way on every retry. Try from each "{" instead, before giving up.
  if (!scored.length) scored = scoredObjectsFromAnyBrace(raw);
  if (!candidates.length && !scored.length) return failed("找不到 JSON 物件");
  if (new Set(scored.map((v) => JSON.stringify(v))).size > 1) {
    return failed(`回覆裡有 ${scored.length} 個內容不同的判決物件，無法判定哪一個才是最終判決`);
  }
  const obj: unknown = scored[0] ?? parsed[parsed.length - 1];
  if (obj === undefined) return failed(`JSON.parse 失敗：${lastErr}`);
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

// `parseError` is set by three different situations, and only one of them is worth retrying.
// The sentinels live here so the orchestrator does not match on prose that may be reworded.
export const REVIEWER_SPAWN_ERROR = "reviewer spawn error";
export const REVIEWER_ZERO_TOOL_CALLS = "reviewer 0 tool calls";

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
    parseError: REVIEWER_ZERO_TOOL_CALLS,
    raw,
  };
}

// The reviewer never ran. Diagnosing this as model misbehaviour sends the operator to swap
// models when the actual fix is the opencode install / UT_OPENCODE_BIN.
export function spawnErrorVerdict(): ReviewVerdict {
  return {
    passed: false,
    scores: {},
    blockers: [
      "Reviewer 程序未能啟動（spawn 失敗），本輪判 REJECT。這是環境問題而非模型問題：" +
        "請確認 opencode CLI 可用，或以 UT_OPENCODE_BIN 指定路徑。",
    ],
    advisories: [],
    belowThreshold: [],
    parseError: REVIEWER_SPAWN_ERROR,
  };
}

/**
 * True when the reviewer answered but the answer could not be read as a verdict.
 *
 * Deliberately narrower than "parseError is set". A spawn error is environmental — retrying
 * three times changes nothing and the message already names the fix. Zero tool calls is a
 * reviewer that answered perfectly well, just without reading anything; that guard has its own
 * fail-closed treatment and its own scenario, and folding it in here would quietly change what
 * that guard does.
 */
export function isUnparseable(v: ReviewVerdict): boolean {
  return (
    !!v.parseError &&
    v.parseError !== REVIEWER_SPAWN_ERROR &&
    v.parseError !== REVIEWER_ZERO_TOOL_CALLS
  );
}

export async function runReviewGate(
  runner: AgentRunner,
  prompt: string,
): Promise<ReviewVerdict> {
  const out = await runner.runReview(prompt);
  if (out.status === "spawn-error") return spawnErrorVerdict();
  if (out.status !== "ok") {
    // The session did not finish: its deadline, requests that kept failing, a context it could
    // not shrink, an opencode that exited on a provider error. Whatever text it left is from a
    // turn that was still working — possibly a verdict written before the model had read the
    // results of the calls in that same turn — so no verdict is taken from it, however complete
    // it looks. And it is not a reviewer that "answered without reading" either: that blocker is
    // fed to the writer, which cannot make a reviewer finish, and runs used to end as writer-no-op
    // with every hard gate green. Marked unparseable, it is retried at the reviewer
    // (UT_REVIEW_MAX_RETRIES) and, if it never finishes, ends the run naming the reviewer.
    return {
      passed: false,
      scores: {},
      blockers: [],
      advisories: [],
      belowThreshold: [],
      parseError: `reviewer session 未完成（status=${out.status}），沒有採用任何判決`,
      raw: out.text,
    };
  }
  if (REVIEWER_MUST_READ && out.toolCallCount === 0) return zeroToolCallVerdict(out.text);
  return parseVerdict(out.text);
}
