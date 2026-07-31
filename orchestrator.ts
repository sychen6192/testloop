// Iteration orchestrator: the single deterministic control loop.
// Zero SDK imports — all agent interaction goes through the AgentRunner interface.
// Each iteration's artifacts land in runs/<ts>/iter-N/ (state in artifacts, not context).
// Review passes when blockers are empty and all six dims meet threshold; feedback carries
// only blockers + below-threshold dims (advisories stay out of the loop to avoid thrash).
//
// Early-abort rules (all fail-closed, none burn remaining rounds):
// - runner spawn-error: the agent never ran; retrying cannot help.
// - writer no-op after a failed round: nothing changed, the same gates would fail identically.
// - identical feedback twice in a row: the loop is stuck, more rounds add cost, not progress.
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_ITER } from "./config";
import { log, banner, tail } from "./libs/log";
import { AgentRunner, BuildTool, ModuleInfo, ReviewVerdict } from "./libs/types";
import { diffSnapshots, snapshotTree, stripRaw } from "./libs/utils";
import { buildGeneratePrompt, buildFixPrompt, buildReviewPrompt, testRootRel } from "./prompts";
import { runBuildAndTests } from "./gates/build";
import { checkCoverage } from "./gates/coverage";
import { runReviewGate } from "./gates/review";

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

// One row per iteration: which gate the round reached and how it ended.
// This is the run's funnel — it shows where rounds die, which is the first thing
// to look at when tuning the loop.
export interface IterationRecord {
  iter: number;
  gate: "writer" | "build" | "coverage" | "review" | "pass";
  outcome: string;
  changedFiles: number;
  writerOutputTokens?: number;
}

export interface OrchestratorResult {
  success: boolean;
  iterations: number;
  // "gates-passed" | "max-iterations" | "runner-spawn-error" | "writer-no-op" | "stuck"
  stopReason: string;
  targetClasses: string[];
  coverageReport: string;
  funnel: IterationRecord[];
  totalOutputTokens?: number;
  finalFeedback?: string;
  finalVerdict?: ReviewVerdict;
}

export async function orchestrate(cfg: OrchestratorConfig): Promise<OrchestratorResult> {
  let feedback: string | null = null;
  let prevFeedback: string | null = null;
  let lastVerdict: ReviewVerdict | undefined;
  let lastCov = "（尚未執行覆蓋率檢查）";
  const funnel: IterationRecord[] = [];
  let totalOutputTokens: number | undefined;
  const testRoot = path.join(cfg.mod.moduleRoot, "src", "test", "java");

  const fail = (stopReason: string, finalFeedback: string, iter: number): OrchestratorResult => ({
    success: false,
    iterations: iter,
    stopReason,
    targetClasses: cfg.targetClasses,
    coverageReport: lastCov,
    funnel,
    totalOutputTokens,
    finalFeedback,
    finalVerdict: lastVerdict,
  });

  for (let iter = 1; iter <= MAX_ITER; iter++) {
    const iterDir = path.join(cfg.runDir, `iter-${iter}`);
    fs.mkdirSync(iterDir, { recursive: true });
    const save = (name: string, content: string) =>
      fs.writeFileSync(path.join(iterDir, name), content);
    const record = (rec: Omit<IterationRecord, "iter">) => funnel.push({ iter, ...rec });

    banner(`第 ${iter}/${MAX_ITER} 輪迭代`);

    // Step 1: generate or fix
    log(`Step 1/4：${feedback ? "依上輪失敗報告修正" : "首次產生"}測試`);
    const prompt = feedback
      ? buildFixPrompt({
          gateReport: feedback,
          standards: cfg.standards,
          mod: cfg.mod,
          targetClasses: cfg.targetClasses,
        })
      : buildGeneratePrompt({
          targetClasses: cfg.targetClasses,
          standards: cfg.standards,
          mod: cfg.mod,
        });
    save("prompt.md", prompt);

    const before = snapshotTree(testRoot);
    const writer = await cfg.runner.runWriter(prompt);
    if (writer.outputTokens !== undefined) {
      totalOutputTokens = (totalOutputTokens ?? 0) + writer.outputTokens;
    }
    save("writer-summary.md", writer.text || "（writer 未回傳文字）");
    log(`[writer 總結] ${tail(writer.text, 1500)}`);

    if (writer.status === "spawn-error") {
      record({ gate: "writer", outcome: "spawn-error", changedFiles: 0 });
      return fail(
        "runner-spawn-error",
        "writer 程序未能啟動（spawn 失敗）。這是環境問題，重試不會改善：" +
          "請確認 opencode CLI 可用，或以 UT_OPENCODE_BIN 指定路徑。",
        iter,
      );
    }

    const changed = diffSnapshots(before, snapshotTree(testRoot));
    save("changed-files.txt", changed.length ? changed.join("\n") : "（本輪未變更任何測試檔）");
    log(`writer 變更了 ${changed.length} 個測試檔`);
    if (changed.length === 0) {
      if (feedback) {
        // A failed gate demanded changes and none arrived — the same gates would fail
        // identically. Common causes: context exhausted, permission-blocked writes.
        record({ gate: "writer", outcome: "no-op", changedFiles: 0 });
        return fail(
          "writer-no-op",
          `上一輪 gate 失敗後，writer 未變更 ${testRootRel(cfg.mod)} 下任何檔案。` +
            "常見原因：模型 context 耗盡、非互動模式寫檔被 permission 擋下（見 README Troubleshooting）。",
          iter,
        );
      }
      // Round 1 with no changes can be legitimate (tests already exist); the gates still
      // judge, but the summary must say the tool generated nothing this run.
      log("[WARN] writer 首輪未變更任何測試檔——gate 仍會執行，但本次執行未新增測試");
    }

    // Step 2: hard gate — compile & test
    log("Step 2/4：執行編譯與測試 gate");
    const build = await runBuildAndTests(cfg.buildTool, cfg.mod);
    save("build.log", build.raw ?? build.report);
    log(build.passed ? "[OK] 編譯與測試 gate：PASS" : "[FAIL] 編譯與測試 gate：FAIL");
    if (!build.passed) {
      record({
        gate: "build",
        outcome: "fail",
        changedFiles: changed.length,
        writerOutputTokens: writer.outputTokens,
      });
      prevFeedback = feedback;
      feedback = build.report;
      save("feedback.md", feedback);
      if (prevFeedback !== null && prevFeedback === feedback) {
        return fail(
          "stuck",
          `連續兩輪得到完全相同的失敗報告，判定迴圈卡住，提前結束。\n${feedback}`,
          iter,
        );
      }
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
      record({
        gate: "coverage",
        outcome: "fail",
        changedFiles: changed.length,
        writerOutputTokens: writer.outputTokens,
      });
      prevFeedback = feedback;
      feedback = `測試全數通過，但覆蓋率未達門檻，請補強缺漏情境的測試。\n${cov.report}`;
      save("feedback.md", feedback);
      if (prevFeedback !== null && prevFeedback === feedback) {
        return fail(
          "stuck",
          `連續兩輪得到完全相同的覆蓋率缺口，判定迴圈卡住，提前結束。\n${cov.report}`,
          iter,
        );
      }
      log("→ 帶著覆蓋率缺口進入下一輪");
      continue;
    }

    // Step 4: review gate
    if (cfg.skipReview) {
      log("Step 4/4：依設定跳過 review gate");
      log("[OK] 全部 hard gate 通過");
      record({
        gate: "pass",
        outcome: "hard-gates-passed",
        changedFiles: changed.length,
        writerOutputTokens: writer.outputTokens,
      });
      return {
        success: true,
        iterations: iter,
        stopReason: "gates-passed",
        targetClasses: cfg.targetClasses,
        coverageReport: cov.report,
        funnel,
        totalOutputTokens,
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
    save("verdict.json", JSON.stringify(verdict, stripRaw, 2));
    if (verdict.raw) save("review-raw.txt", verdict.raw);

    if (verdict.passed) {
      log("[OK] 品質 review gate：PASS");
      log("所有關卡通過（編譯 / 測試 / 覆蓋率 / 品質審查）");
      record({
        gate: "pass",
        outcome: "all-gates-passed",
        changedFiles: changed.length,
        writerOutputTokens: writer.outputTokens,
      });
      return {
        success: true,
        iterations: iter,
        stopReason: "gates-passed",
        targetClasses: cfg.targetClasses,
        coverageReport: cov.report,
        funnel,
        totalOutputTokens,
        finalVerdict: verdict,
      };
    }

    log(
      `[FAIL] 品質 review gate：REJECT（blockers ${verdict.blockers.length}、` +
        `低於門檻維度 ${verdict.belowThreshold.length}）`,
    );
    verdict.blockers.forEach((b, i) => log(`  blocker ${i + 1}. ${b}`));
    verdict.belowThreshold.forEach((d) => log(`  低分維度：${d}`));
    record({
      gate: "review",
      outcome: "reject",
      changedFiles: changed.length,
      writerOutputTokens: writer.outputTokens,
    });

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
    prevFeedback = feedback;
    feedback = fb.join("\n");
    save("feedback.md", feedback);
    if (prevFeedback !== null && prevFeedback === feedback) {
      return fail(
        "stuck",
        `連續兩輪得到完全相同的審查意見，判定迴圈卡住，提前結束。\n${feedback}`,
        iter,
      );
    }
    log("→ 帶著審查意見進入下一輪");
  }

  return fail("max-iterations", feedback ?? "達到最大迭代次數", MAX_ITER);
}
