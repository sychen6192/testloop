// Hard gate: JaCoCo coverage.
// Reports live under the *module's* target/, not the repo root.
// Parsing gotcha: prefer the file-level <sourcefile> aggregate; else the class block's
// LAST counter (JaCoCo's class-level counter comes after all methods — the first counter
// is method-level and badly undercounts).
import * as fs from "node:fs";
import * as path from "node:path";
import { MIN_LINE_COV, MIN_BRANCH_COV, STRICT_COV } from "../config";
import { log } from "../libs/log";
import { GateResult, ModuleInfo } from "../libs/types";

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function lastCounterPct(block: string, type: string): number | null {
  const re = new RegExp(`<counter type="${type}" missed="(\\d+)" covered="(\\d+)"/>`, "g");
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(block))) last = m;
  if (!last) return null;
  const missed = Number(last[1]);
  const covered = Number(last[2]);
  return (covered / Math.max(1, missed + covered)) * 100;
}

// Pure: parse JaCoCo XML, check each class against thresholds.
export function parseJacocoReport(
  xml: string,
  targetClasses: string[],
  min: { line: number; branch: number } = { line: MIN_LINE_COV, branch: MIN_BRANCH_COV },
): { passed: boolean; lines: string[] } {
  const lines: string[] = [];
  let allPass = true;

  for (const cls of targetClasses) {
    const simple = path.basename(cls);

    // Narrow to the right <package> block by source path (avoid same-name collisions).
    const pkgMatch = cls.replace(/\\/g, "/").match(/src\/main\/java\/(.+)\/[^/]+\.java$/);
    let scope = xml;
    if (pkgMatch) {
      const pkgRe = new RegExp(`<package name="${escRe(pkgMatch[1])}">[\\s\\S]*?</package>`);
      const pm = xml.match(pkgRe);
      if (pm) scope = pm[0];
    }

    // 1) file-level <sourcefile> aggregate (includes inner classes, most accurate)
    const sfRe = new RegExp(`<sourcefile name="${escRe(simple)}">[\\s\\S]*?</sourcefile>`);
    let block = scope.match(sfRe)?.[0];
    // 2) fallback: class block — take the LAST counter (class-level aggregate)
    if (!block) {
      const clsRe = new RegExp(
        `<class[^>]*sourcefilename="${escRe(simple)}"[\\s\\S]*?</class>`,
      );
      block = scope.match(clsRe)?.[0];
    }
    if (!block) {
      lines.push(`- ${simple}: 在 JaCoCo 報告中找不到（可能完全沒被測試觸及）`);
      allPass = false;
      continue;
    }

    const line = lastCounterPct(block, "LINE");
    const branch = lastCounterPct(block, "BRANCH");
    const lineOk = line === null || line >= min.line;
    const branchOk = branch === null || branch >= min.branch;
    if (!lineOk || !branchOk) allPass = false;
    lines.push(
      `- ${simple}: line=${line?.toFixed(1) ?? "N/A"}%（門檻 ${min.line}）, ` +
        `branch=${branch?.toFixed(1) ?? "N/A"}%（門檻 ${min.branch}） ` +
        `${lineOk && branchOk ? "PASS" : "FAIL"}`,
    );
  }
  return { passed: allPass, lines };
}

export function locateJacocoXml(mod: ModuleInfo): string | undefined {
  const candidates = [
    process.env.UT_JACOCO_XML,
    path.join(mod.moduleRoot, "target", "site", "jacoco", "jacoco.xml"),
    path.join(mod.moduleRoot, "build", "reports", "jacoco", "test", "jacocoTestReport.xml"),
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p));
}

export function checkCoverage(targetClasses: string[], mod: ModuleInfo): GateResult {
  const xmlPath = locateJacocoXml(mod);
  if (!xmlPath) {
    const strictMsg =
      "，UT_STRICT_COV=1 → 覆蓋率 gate 判定 FAIL。請在模組加入 jacoco-maven-plugin" +
      "（prepare-agent + report 綁定 test phase），或設 UT_JACOCO_XML 指定報告路徑";
    const looseMsg =
      "，略過覆蓋率 gate。建議加入 jacoco plugin，或設 UT_STRICT_COV=1 強制要求";
    return {
      passed: !STRICT_COV,
      report: `（在 ${mod.moduleRoot} 未偵測到 JaCoCo 報告${STRICT_COV ? strictMsg : looseMsg}。）`,
    };
  }
  log(`解析覆蓋率報告：${xmlPath}`);
  const xml = fs.readFileSync(xmlPath, "utf8");
  const { passed, lines } = parseJacocoReport(xml, targetClasses);
  return { passed, report: `覆蓋率檢查（${xmlPath}）：\n${lines.join("\n")}` };
}
