// Iteration orchestrator: the single deterministic control loop.
// Zero SDK imports — all agent interaction goes through the AgentRunner interface.
// Each iteration's artifacts land in runs/<ts>/iter-N/ (state in artifacts, not context).
// Review passes when blockers are empty and all six dims meet threshold; feedback carries
// only blockers + below-threshold dims (advisories stay out of the loop to avoid thrash).
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_ITER } from "../config";
import { log, banner, tail } from "../libs/log";
import {
  AgentRunner,
  BuildTool,
  ModuleInfo,
  ReviewVerdict,
} from "../libs/types";
import { buildGeneratePrompt } from "../prompts/generate";
import { buildFixPrompt } from "../prompts/fix";
import { runBuildAndTests } from "../gates/build";
import { checkCoverage } from "../gates/coverage";
import { runReviewGate } from "../review/gate";
import { buildReviewPrompt } from "../prompts/review";

export interface OrchestratorConfig {
  targetClasses: string[];
  buildTool: BuildTool;
  runner: AgentRunner;
  standards: string;
  rubric: string;
  skipReview: boolean;
  mod: ModuleInfo;
  runDir: string;
}

export interface OrchestratorResult {
  success: boolean;
  iterations: number;
  targetClasses: string[];
  coverageReport: string;
  finalFeedback?: string;
  finalVerdict?: ReviewVerdict;
}

export async function orchestrate(cfg: OrchestratorConfig): Promise<OrchestratorResult> {
  let feedback: string | null = null;
  let lastVerdict: ReviewVerdict | undefined;
  let lastCov = "（尚未執行覆蓋率檢查）";

  for (let iter = 1; iter <= MAX_ITER; iter++) {
    const iterDir = path.join(cfg.runDir, `iter-${iter}`);
    fs.mkdirSync(iterDir, { recursive: true });
    const save = (name: string, content: string) =>
      fs.writeFileSync(path.join(iterDir, name), content);

    banner(`第 ${iter}/${MAX_ITER} 輪迭代`);

    // Step 1: generate or fix
    log(`Step 1/4：${feedback ? "依上輪失敗報告修正" : "首次產生"}測試`);
    const prompt = feedback
      ? buildFixPrompt({ gateReport: feedback, standards: cfg.standards, mod: cfg.mod })
      : buildGeneratePrompt({
          targetClasses: cfg.targetClasses,
          standards: cfg.standards,
          mod: cfg.mod,
        });
    save("prompt.md", prompt);
    const agentSummary = await cfg.runner.runWriter(prompt);
    save("writer-summary.md", agentSummary || "（writer 未回傳文字）");
    log(`[writer 總結] ${tail(agentSummary, 1500)}`);

    // Step 2: hard gate — compile & test
    log("Step 2/4：執行編譯與測試 gate");
    const build = await runBuildAndTests(cfg.buildTool, cfg.mod);
    save("build.log", build.raw ?? build.report);
    log(build.passed ? "[OK] 編譯與測試 gate：PASS" : "[FAIL] 編譯與測試 gate：FAIL");
    if (!build.passed) {
      feedback = build.report;
      save("feedback.md", feedback);
      log("→ 帶著失敗報告進入下一輪");
      continue;
    }

    // Step 3: hard gate — coverage
    log("Step 3/4：檢查覆蓋率 gate");
    const cov = checkCoverage(cfg.targetClasses, cfg.mod);
    lastCov = cov.report;
    save("coverage.txt", cov.report);
    log(cov.passed ? "[OK] 覆蓋率 gate：PASS" : "[FAIL] 覆蓋率 gate：FAIL");
    if (!cov.passed) {
      feedback = `測試全數通過，但覆蓋率未達門檻，請補強缺漏情境的測試。\n${cov.report}`;
      save("feedback.md", feedback);
      log("→ 帶著覆蓋率缺口進入下一輪");
      continue;
    }

    // Step 4: review gate
    if (cfg.skipReview) {
      log("Step 4/4：依設定跳過 review gate");
      log("[OK] 全部 hard gate 通過");
      return {
        success: true,
        iterations: iter,
        targetClasses: cfg.targetClasses,
        coverageReport: cov.report,
      };
    }
    log("Step 4/4：執行品質 review gate");
    const reviewPrompt = buildReviewPrompt({
      targetClasses: cfg.targetClasses,
      rubric: cfg.rubric,
      mod: cfg.mod,
    });
    save("review-prompt.md", reviewPrompt);
    const verdict = await runReviewGate(cfg.runner, reviewPrompt);
    lastVerdict = verdict;
    save(
      "verdict.json",
      JSON.stringify(verdict, (k, v) => (k === "raw" ? undefined : v), 2),
    );
    if (verdict.raw) save("review-raw.txt", verdict.raw);

    if (verdict.passed) {
      log("[OK] 品質 review gate：PASS");
      log("所有關卡通過（編譯 / 測試 / 覆蓋率 / 品質審查）");
      return {
        success: true,
        iterations: iter,
        targetClasses: cfg.targetClasses,
        coverageReport: cov.report,
        finalVerdict: verdict,
      };
    }

    log(
      `[FAIL] 品質 review gate：REJECT（blockers ${verdict.blockers.length}、` +
        `低於門檻維度 ${verdict.belowThreshold.length}）`,
    );
    verdict.blockers.forEach((b, i) => log(`  blocker ${i + 1}. ${b}`));
    verdict.belowThreshold.forEach((d) => log(`  低分維度：${d}`));

    const fb: string[] = [
      "編譯、測試與覆蓋率皆通過，但品質審查未過，請修正以下問題（僅修改測試碼）：",
    ];
    if (verdict.blockers.length) {
      fb.push("Blockers（必須全部修正）：");
      verdict.blockers.forEach((b, i) => fb.push(`${i + 1}. ${b}`));
    }
    if (verdict.belowThreshold.length) {
      fb.push(`低於門檻的維度：${verdict.belowThreshold.join("、")}。請針對該維度定義補強。`);
    }
    fb.push("（advisories 為建議級，本輪不需處理。）");
    feedback = fb.join("\n");
    save("feedback.md", feedback);
    log("→ 帶著審查意見進入下一輪");
  }

  return {
    success: false,
    iterations: MAX_ITER,
    targetClasses: cfg.targetClasses,
    coverageReport: lastCov,
    finalFeedback: feedback ?? "達到最大迭代次數",
    finalVerdict: lastVerdict,
  };
}
