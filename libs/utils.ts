/** 純函式工具：檔案遍歷、多模組偵測、測試路徑推導（皆吃參數，selftest 可測） */
import * as fs from "node:fs";
import * as path from "node:path";
import { ModuleInfo } from "./types";

/** 列出目標（資料夾或單一 .java 檔）內的 Java 類別，回傳相對 repoRoot 的路徑 */
export function listJavaClasses(target: string, repoRoot: string): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    const b = path.basename(p);
    if (b.endsWith(".java") && b !== "package-info.java" && b !== "module-info.java") {
      out.push(path.relative(repoRoot, p));
    }
  };
  const st = fs.statSync(target);
  if (st.isFile()) {
    add(target);
    return out;
  }
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else add(p);
    }
  };
  walk(target);
  return out;
}

function hasBuildFile(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "pom.xml")) ||
    fs.existsSync(path.join(dir, "build.gradle")) ||
    fs.existsSync(path.join(dir, "build.gradle.kts"))
  );
}

/**
 * 多模組偵測：從目標路徑向上找「最近的」pom.xml / build.gradle，
 * 該目錄即模組根。找不到則退回 repoRoot（讓 detectBuildTool 決定生死）。
 */
export function findModuleInfo(absTarget: string, repoRoot: string): ModuleInfo {
  let dir = fs.statSync(absTarget).isDirectory() ? absTarget : path.dirname(absTarget);
  while (!hasBuildFile(dir)) {
    if (dir === repoRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) {
      dir = repoRoot;
      break;
    }
    dir = parent;
  }
  const moduleRoot = dir;
  const moduleRel = path.relative(repoRoot, moduleRoot);
  return { moduleRoot, moduleRel, multiModule: moduleRel !== "" };
}

/** 由來源檔路徑推導預期測試檔路徑：src/main/java → src/test/java、Foo → FooTest */
export function expectedTestPath(clsRelPath: string): string {
  const norm = clsRelPath.replace(/\\/g, "/");
  const renamed = norm.replace(/([^/]+)\.java$/, (_m, n: string) => `${n}Test.java`);
  if (renamed.includes("src/main/java/")) {
    return renamed.replace("src/main/java/", "src/test/java/");
  }
  return renamed;
}
