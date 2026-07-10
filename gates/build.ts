/**
 * Hard gate：編譯 + 測試。
 * 多模組感知：
 * - Maven：REPO_ROOT 有 reactor pom → 在 REPO_ROOT 跑 `mvn -pl <module> -am test`；
 *          否則直接在模組目錄跑 `mvn test`。
 * - Gradle：多模組用 `-p <module>`（best-effort；本專案主力是 Maven）。
 * 測試報告一律到「模組」的 target/build 底下找（多模組的 report 不在 repo 根）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, MAVEN_EXTRA_ARGS } from "../config";
import { tail, die } from "../libs/log";
import { shLive } from "../libs/shell";
import { BuildTool, GateResult, ModuleInfo } from "../libs/types";

export function detectBuildTool(moduleRoot: string): BuildTool {
  if (fs.existsSync(path.join(moduleRoot, "pom.xml"))) return "maven";
  if (
    fs.existsSync(path.join(moduleRoot, "build.gradle")) ||
    fs.existsSync(path.join(moduleRoot, "build.gradle.kts"))
  ) {
    return "gradle";
  }
  die(`在 ${moduleRoot} 偵測不到 pom.xml 或 build.gradle`);
}

function collectSurefireFailures(moduleRoot: string): string {
  let failures = "";
  const surefireDir = path.join(moduleRoot, "target", "surefire-reports");
  if (fs.existsSync(surefireDir)) {
    for (const f of fs.readdirSync(surefireDir).filter((f) => f.endsWith(".txt"))) {
      const txt = fs.readFileSync(path.join(surefireDir, f), "utf8");
      if (/FAILURE|ERROR/i.test(txt)) failures += `\n----- ${f} -----\n${tail(txt, 2000)}`;
    }
  }
  return failures;
}

function collectGradleFailures(moduleRoot: string): string {
  let failures = "";
  const dir = path.join(moduleRoot, "build", "test-results", "test");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((f) => f.startsWith("TEST-") && f.endsWith(".xml"))) {
      const xml = fs.readFileSync(path.join(dir, f), "utf8");
      const blocks = [
        ...(xml.match(/<failure[^>]*>[\s\S]*?<\/failure>/g) ?? []),
        ...(xml.match(/<error[^>]*>[\s\S]*?<\/error>/g) ?? []),
      ];
      for (const b of blocks) {
        const msg = b.replace(/<[^>]*>/g, "").trim();
        if (msg) failures += `\n----- ${f} -----\n${tail(msg, 1500)}`;
      }
    }
  }
  return failures;
}

export async function runBuildAndTests(
  tool: BuildTool,
  mod: ModuleInfo,
): Promise<GateResult> {
  const isWin = process.platform === "win32";
  let r: { code: number; out: string };

  if (tool === "maven") {
    const wrapper = isWin ? "mvnw.cmd" : "mvnw";
    const reactorHasPom = fs.existsSync(path.join(REPO_ROOT, "pom.xml"));
    const useReactor = mod.multiModule && reactorHasPom;
    const cwd = useReactor ? REPO_ROOT : mod.moduleRoot;
    const wrapperAt = fs.existsSync(path.join(cwd, wrapper));
    const cmd = wrapperAt ? (isWin ? wrapper : `./${wrapper}`) : "mvn";
    const args = [
      ...(useReactor ? ["-pl", mod.moduleRel, "-am"] : []),
      "-DskipITs",
      "test",
      ...MAVEN_EXTRA_ARGS,
    ];
    r = await shLive(cmd, args, "[mvn]", cwd);
  } else {
    const wrapper = isWin ? "gradlew.bat" : "gradlew";
    const wrapperAt = fs.existsSync(path.join(REPO_ROOT, wrapper));
    const cmd = wrapperAt ? (isWin ? wrapper : `./${wrapper}`) : "gradle";
    const args = [
      ...(mod.multiModule ? ["-p", mod.moduleRel] : []),
      "test",
      "--console=plain",
    ];
    r = await shLive(cmd, args, "[gradle]", REPO_ROOT);
  }

  if (r.code === 0) {
    return { passed: true, report: "編譯與測試全數通過。", raw: r.out };
  }

  const failures =
    tool === "maven"
      ? collectSurefireFailures(mod.moduleRoot)
      : collectGradleFailures(mod.moduleRoot);

  return {
    passed: false,
    report: `編譯或測試失敗（exit=${r.code}）。\n建置輸出（節錄）：\n${tail(r.out)}\n${failures}`,
    raw: r.out,
  };
}
