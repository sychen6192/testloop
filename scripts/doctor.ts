// Preflight for the central-clone pipeline. Run from the target Java repo root.
// Usage: npx tsx <tool>/scripts/doctor.ts [targetPath] [--smoke]
// The env default below MUST run before importing ../config (dynamic imports only).
if (!process.env.UT_AGENT_TIMEOUT_MS) process.env.UT_AGENT_TIMEOUT_MS = "60000"; // short --smoke

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const config = await import("../config");
const { resolveAgentPath, contractViolations, WRITER_RULES, REVIEWER_RULES } = await import(
  "../libs/guard"
);
const { loadRubric } = await import("../libs/rubric");
const { findModuleInfo } = await import("../libs/utils");

type Status = "OK" | "WARN" | "FAIL";
const rows: Array<{ status: Status; name: string; note: string }> = [];
const add = (status: Status, name: string, note = "") => rows.push({ status, name, note });

const args = process.argv.slice(2);
const smoke = args.includes("--smoke");
const target = args.find((a) => !a.startsWith("--"));

// 1. node
const major = Number(process.versions.node.split(".")[0]);
add(major >= 20 ? "OK" : "FAIL", "node >= 20", `目前 ${process.versions.node}`);

// 2. opencode CLI
const ver = spawnSync(config.OPENCODE_BIN, ["--version"], { encoding: "utf8" });
if (ver.status === 0) add("OK", "opencode CLI", ver.stdout.trim());
else add("FAIL", "opencode CLI", `找不到 ${config.OPENCODE_BIN}——安裝 opencode 或設 UT_OPENCODE_BIN`);

// 3. agents (repo-local wins, global fallback)
for (const { name, rules } of [
  { name: "ut-writer", rules: WRITER_RULES },
  { name: "ut-reviewer", rules: REVIEWER_RULES },
]) {
  const res = resolveAgentPath(name, config.REPO_ROOT, config.GLOBAL_OPENCODE_DIR);
  if (!res) add("FAIL", `agent ${name}`, "repo 與 global 皆無——在工具 clone 執行 npm run setup");
  else {
    const errs = contractViolations(res.path, rules);
    if (errs.length) add("FAIL", `agent ${name}`, errs.join("；"));
    else add("OK", `agent ${name}`, `${res.source}：${res.path}`);
  }
}

// 4. rubric
const { rubric, source } = loadRubric(config.SKILL_DIR_CANDIDATES);
if (rubric) add("OK", "評分 rubric", source);
else add("WARN", "評分 rubric", "找不到 references/rubric.md——review gate 將退回 standards 全文");

// 5. standards
add(fs.existsSync(config.STANDARDS_PATH) ? "OK" : "FAIL", "品質標準檔", config.STANDARDS_PATH);

// 6-8. target-repo context
const hasPom = fs.existsSync(path.join(config.REPO_ROOT, "pom.xml"));
const hasGradle =
  fs.existsSync(path.join(config.REPO_ROOT, "build.gradle")) ||
  fs.existsSync(path.join(config.REPO_ROOT, "build.gradle.kts"));
const isToolItself =
  fs.existsSync(path.join(config.REPO_ROOT, "loop.ts")) &&
  fs.existsSync(path.join(config.REPO_ROOT, "scripts", "doctor.ts"));

if (hasPom || hasGradle) {
  add("OK", "Java repo（cwd）", config.REPO_ROOT);
  if (hasPom) {
    const wrapper = path.join(config.REPO_ROOT, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
    if (fs.existsSync(wrapper)) add("OK", "Maven", "使用 repo 內 mvnw");
    else if (spawnSync("mvn", ["-v"], { encoding: "utf8" }).status === 0)
      add("OK", "Maven", "使用 PATH 中的 mvn");
    else add("FAIL", "Maven", "無 mvnw 也無 mvn——安裝 Maven 或補 wrapper");
  } else {
    const wrapper = path.join(
      config.REPO_ROOT,
      process.platform === "win32" ? "gradlew.bat" : "gradlew",
    );
    if (fs.existsSync(wrapper)) add("OK", "Gradle", "使用 repo 內 gradlew");
    else if (spawnSync("gradle", ["-v"], { encoding: "utf8" }).status === 0)
      add("OK", "Gradle", "使用 PATH 中的 gradle");
    else add("FAIL", "Gradle", "無 gradlew 也無 gradle");
  }
  if (target) {
    const absTarget = path.resolve(config.REPO_ROOT, target);
    if (!fs.existsSync(absTarget)) add("FAIL", "目標路徑", `不存在：${absTarget}`);
    else {
      const mod = findModuleInfo(absTarget, config.REPO_ROOT);
      add("OK", "目標模組", mod.multiModule ? mod.moduleRel : "（單一模組）");
      const modPom = path.join(mod.moduleRoot, "pom.xml");
      if (fs.existsSync(modPom)) {
        if (fs.readFileSync(modPom, "utf8").includes("jacoco-maven-plugin"))
          add("OK", "JaCoCo", "模組 pom 含 jacoco-maven-plugin");
        else
          add(
            "WARN",
            "JaCoCo",
            '模組 pom 未見 jacoco——coverage gate 將略過；可加 plugin、設 UT_MAVEN_ARGS="jacoco:report" 或 UT_STRICT_COV=1',
          );
      } else add("WARN", "JaCoCo", "Gradle 模組：請自行確認 jacocoTestReport 設定");
    }
  } else add("WARN", "目標模組", "未提供目標路徑——帶上 <targetPath> 可加檢 JaCoCo");
} else if (isToolItself) {
  add("WARN", "Java repo（cwd）", "目前在工具 clone 內——環境項已檢查；到目標 Java repo 根再跑一次以檢查 repo 項目");
} else {
  add("FAIL", "Java repo（cwd）", "此目錄無 pom.xml / build.gradle——請在目標 Java repo 根執行");
}

// 9. --smoke: one read-only reviewer ping via AgentRunner (never spawn the agent CLI here)
if (smoke) {
  const { createRunner } = await import("../runners/runner");
  try {
    const runner = await createRunner();
    const out = await runner.runReview("這是連線測試，請只回覆：OK");
    if (out.trim()) add("OK", "smoke（reviewer）", out.trim().slice(0, 60));
    else add("FAIL", "smoke（reviewer）", "無回應——檢查 provider 設定（opencode auth）與 agent 的 model 欄位");
  } catch (e) {
    add("FAIL", "smoke（reviewer）", e instanceof Error ? e.message : String(e));
  }
}

console.log("\ntestgen doctor\n");
for (const r of rows) console.log(`  [${r.status}] ${r.name}${r.note ? ` — ${r.note}` : ""}`);
const fails = rows.filter((r) => r.status === "FAIL").length;
console.log(fails ? `\n${fails} 項 FAIL——依提示修復後重跑` : "\n全部通過（WARN 為提示性）");
process.exit(fails ? 1 : 0);
