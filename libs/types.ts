/** 共用型別（SSOT：其他模組一律從此 import） */

export type BuildTool = "maven" | "gradle";

export interface GateResult {
  passed: boolean;
  report: string;
  /** 完整原始輸出（build.log 落盤用） */
  raw?: string;
}

/** Runtime adapter：核心零 SDK import 的關鍵 interface */
export interface AgentRunner {
  runWriter(prompt: string): Promise<string>;
  runReview(prompt: string): Promise<string>;
}

export const REVIEW_DIMENSIONS = [
  "effectiveness",
  "coverage",
  "independence",
  "readability",
  "fast_reliable",
  "mock_appropriateness",
] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

export type ReviewScores = Record<ReviewDimension, number>;

export interface ReviewVerdict {
  passed: boolean;
  /** 六維 0-10 整數（對齊 skill rubric）；解析失敗時為空物件 */
  scores: Partial<ReviewScores>;
  /** 違反標準硬規則（≈ skill severity=high）：必須全部修正才能過關 */
  blockers: string[];
  /** 建議級改善（≈ severity=medium/low）：不擋關、不進下一輪 feedback（防 thrash） */
  advisories: string[];
  /** 低於門檻的維度描述，例如 "coverage（6 < 門檻 7）" */
  belowThreshold: string[];
  /** Σ(score×weight)×10（0-100），由 pipeline 依 skill 權重確定性計算 */
  weightedScore?: number;
  /** A/B/C/D（skill bands：85/70/55），僅供報告，不作 gate 條件 */
  grade?: string;
  parseError?: string;
  raw?: string;
}

/** 多模組資訊：由目標路徑向上找最近的 pom.xml / build.gradle 推得 */
export interface ModuleInfo {
  /** 模組根目錄（絕對路徑）。單一模組時 = REPO_ROOT */
  moduleRoot: string;
  /** 相對 REPO_ROOT 的模組路徑。單一模組時 = ""（空字串） */
  moduleRel: string;
  /** moduleRel !== ""，即目標位於子模組內 */
  multiModule: boolean;
}
