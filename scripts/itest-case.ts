// One integration scenario, executed inside the fixture repo.
//
// Spawned as a child process, never imported: config.ts reads process.cwd() and every env
// knob at import time, so "this scenario runs with MAX_ITER=3 against that fixture" can only
// be expressed as a process boundary. The driver sets cwd and env; this file just runs.
//
// Everything under test is the real thing — orchestrate(), the real build gate spawning a
// real child process, the real coverage and review gates. Only the writer and the model
// endpoint are scripted.
import * as path from "node:path";
import { applyWriterAction, RUN_DIR, Scenario, targetDirOf } from "./itest-lib";
import { byName } from "./itest-scenarios";
import { orchestrate, repairBaseline } from "../orchestrator";
import { runBaseline } from "../gates/build";
import { findExistingTests, findModuleInfo, listJavaClasses } from "../libs/utils";
import { scanTestConventions } from "../libs/conventions";
import { AgentRunner, AgentRunOutput } from "../libs/types";
import { REPO_ROOT, SKIP_REVIEW } from "../config";

class ScriptedRunner implements AgentRunner {
  private writerCalls = 0;
  private reviewCalls = 0;
  constructor(private readonly sc: Scenario) {}

  async runWriter(): Promise<AgentRunOutput> {
    const list = this.sc.writer ?? [];
    const a = list[Math.min(this.writerCalls, list.length - 1)] ?? {};
    this.writerCalls++;
    if (a.status === "spawn-error") return { text: "", status: "spawn-error" };
    applyWriterAction(REPO_ROOT, a);
    return {
      text: a.text ?? `scripted writer round ${this.writerCalls}`,
      status: "ok",
      toolCallCount: 1,
      outputTokens: a.outputTokens ?? 10,
    };
  }

  async runReview(): Promise<AgentRunOutput> {
    const list = this.sc.review ?? [];
    const a = list[Math.min(this.reviewCalls, list.length - 1)];
    this.reviewCalls++;
    if (!a) return { text: "{}", status: "ok", toolCallCount: 1 };
    if (a.status === "spawn-error") return { text: "", status: "spawn-error" };
    if (a.status === "timeout") return { text: a.text, status: "timeout", toolCallCount: a.toolCallCount ?? 0 };
    return { text: a.text, status: "ok", toolCallCount: a.toolCallCount ?? 2, outputTokens: 5 };
  }
}

async function main() {
  const sc = byName(process.argv[2]);
  const runner = new ScriptedRunner(sc);
  const runDir = path.join(REPO_ROOT, RUN_DIR);
  const absTarget = path.join(REPO_ROOT, targetDirOf(sc));
  const mod = findModuleInfo(absTarget, REPO_ROOT);
  const targetClasses = listJavaClasses(absTarget, REPO_ROOT);
  const conventions = scanTestConventions(
    path.join(mod.moduleRoot, "src", "test", "java"),
    REPO_ROOT,
  );

  let result: unknown;
  if (sc.entry === "repair") {
    const baseline = await runBaseline("maven", mod);
    result = await repairBaseline({
      runner,
      buildTool: "maven",
      standards: "（測試用 standards）",
      mod,
      runDir,
      baseline,
    });
  } else {
    result = await orchestrate({
      targetClasses,
      buildTool: "maven",
      runner,
      standards: "（測試用 standards）",
      rubric: "（測試用 rubric）",
      skipReview: SKIP_REVIEW,
      mod,
      runDir,
      existingTests: targetClasses.map((cls) => ({ cls, tests: findExistingTests(cls, REPO_ROOT) })),
      conventions,
    });
  }
  // The driver parses this line out of the stream; gate logging shares the same stdout.
  console.log(`ITEST_RESULT:${JSON.stringify(result)}`);
}

main().catch((e) => {
  console.log(`ITEST_RESULT:${JSON.stringify({ crashed: String(e?.stack ?? e) })}`);
  process.exit(1);
});
