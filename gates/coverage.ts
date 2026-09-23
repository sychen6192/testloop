// Hard gate: JaCoCo coverage.
// Reports live under the *module's* target/, not the repo root.
// Parsing gotcha: prefer the file-level <sourcefile> aggregate; else the class block's
// LAST counter (JaCoCo's class-level counter comes after all methods — the first counter
// is method-level and badly undercounts).
import * as fs from "node:fs";
import * as path from "node:path";
import { MIN_LINE_COV, MIN_BRANCH_COV, STRICT_COV, REPO_ROOT } from "../config";
import { log } from "../libs/log";
import { GateResult, ModuleInfo } from "../libs/types";

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Compress sorted line numbers into "12-15, 22, 30-31" ranges.
export function toRanges(nums: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(i === j ? String(nums[i]) : `${nums[i]}-${nums[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

// Missed line numbers from a <sourcefile> block's <line nr= mi=> entries.
// mi > 0 means the line has missed instructions. Feeding the writer the exact lines beats
// telling it "62% < 80" and making it re-derive what is uncovered.
export function missedLines(block: string): number[] {
  const re = /<line nr="(\d+)" mi="(\d+)"/g;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    if (Number(m[2]) > 0) out.push(Number(m[1]));
  }
  return out;
}

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

// One <sourcefile> or <class> element whose `attrName` attribute is `value`.
// undefined = no such element; body null = the element is self-closing.
//
// JaCoCo writes a type with no executable code — an interface with only abstract methods, an
// annotation, a constants holder whose private constructor it filters — as a self-closing element
// with no counters: `<sourcefile name="TaxRateProvider.java"/>`. A pattern that insists on
// `<sourcefile name="X">…</sourcefile>` reports such a type as missing, and the gate then fails on a
// class that has nothing to cover — every round, identically, until stuck. The <class> fallback was
// worse: `<class …sourcefilename="X"/>` followed by `[\s\S]*?</class>` ran on into the NEXT class and
// read that class's counters as this one's.
function findElement(
  xml: string,
  tag: "sourcefile" | "class",
  attrName: string,
  value: string,
): { body: string | null } | undefined {
  const re = new RegExp(`<${tag}\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/${tag}>)`, "g");
  const want = `${attrName}="${value}"`;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (!new RegExp(`(?:^|\\s)${escRe(want)}`).test(m[1])) continue;
    return { body: m[2] === "/>" ? null : (m[3] ?? "") };
  }
  return undefined;
}

// Pure: parse JaCoCo XML, check each class against thresholds.
export function parseJacocoReport(
  xml: string,
  targetClasses: string[],
  min: { line: number; branch: number } = { line: MIN_LINE_COV, branch: MIN_BRANCH_COV },
  // The package of a class whose path does not say it (a source root other than
  // src/main/java). Without one the whole report is searched, and the first same-named file in
  // any package wins — another package's Util.java answering for this one.
  pkgOf: (cls: string) => string | undefined = () => undefined,
): { passed: boolean; lines: string[] } {
  const lines: string[] = [];
  let allPass = true;

  for (const cls of targetClasses) {
    const simple = path.basename(cls);

    // Narrow to the right <package> block by source path (avoid same-name collisions).
    const pkg = cls.replace(/\\/g, "/").match(/src\/main\/java\/(.+)\/[^/]+\.java$/)?.[1] ?? pkgOf(cls);
    let scope = xml;
    if (pkg !== undefined) {
      const pkgRe = new RegExp(`<package name="${escRe(pkg)}">[\\s\\S]*?</package>`);
      const pm = xml.match(pkgRe);
      if (pm) scope = pm[0];
    }

    // 1) file-level <sourcefile> aggregate (includes inner classes, most accurate)
    // 2) fallback: class block — take the LAST counter (class-level aggregate)
    const el =
      findElement(scope, "sourcefile", "name", simple) ??
      findElement(scope, "class", "sourcefilename", simple);
    if (!el) {
      lines.push(`- ${simple}: 在 JaCoCo 報告中找不到（可能完全沒被測試觸及）`);
      allPass = false;
      continue;
    }
    const block = el.body ?? "";

    // A class compiled without line debug info (-g:none, <debug>false</debug>) has instructions
    // but no LINE counter; its instruction coverage stands in for line coverage rather than the
    // class being waved through as code-less.
    const instr = lastCounterPct(block, "INSTRUCTION");
    const line = lastCounterPct(block, "LINE") ?? instr;
    const branch = lastCounterPct(block, "BRANCH");
    if (line === null && branch === null) {
      // JaCoCo analyzed the class and found nothing to execute. There is nothing a test could
      // cover, so there is nothing for this gate to hold the writer to.
      lines.push(
        `- ${simple}: 沒有可執行的程式碼（JaCoCo 無任何計數器，例如只有抽象方法的 interface、` +
          `annotation、常數類別），不列入覆蓋率門檻`,
      );
      continue;
    }
    const lineOk = line === null || line >= min.line;
    const branchOk = branch === null || branch >= min.branch;
    if (!lineOk || !branchOk) allPass = false;
    lines.push(
      `- ${simple}: line=${line?.toFixed(1) ?? "N/A"}%（門檻 ${min.line}）, ` +
        `branch=${branch?.toFixed(1) ?? "N/A"}%（門檻 ${min.branch}） ` +
        `${lineOk && branchOk ? "PASS" : "FAIL"}`,
    );
    if (!lineOk || !branchOk) {
      const missed = missedLines(block);
      if (missed.length) lines.push(`  未覆蓋行：${toRanges(missed)}`);
    }
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

// Pure-ish: a report older than the build that was supposed to produce it is not this
// round's coverage — it is whatever the last run left behind (report goal bound to verify,
// not test, is the usual cause). Reading it inflates the gate the same way appended exec
// data does: the tests may cover nothing and still pass. `since` undefined = no check.
export function reportIsStale(xmlPath: string, since: number | undefined): boolean {
  if (since === undefined) return false;
  try {
    return fs.statSync(xmlPath).mtimeMs < since;
  } catch {
    return true;
  }
}

export function checkCoverage(
  targetClasses: string[],
  mod: ModuleInfo,
  since?: number,
): GateResult {
  const xmlPath = locateJacocoXml(mod);
  if (!xmlPath || reportIsStale(xmlPath, since)) {
    const why = xmlPath
      ? `${xmlPath} 的 JaCoCo 報告比本輪建置還舊——report goal 沒有在 test phase 重新產生` +
        `（常見原因：report 綁在 verify），視同本輪無報告`
      : `在 ${mod.moduleRoot} 未偵測到 JaCoCo 報告`;
    const strictMsg =
      "，UT_STRICT_COV=1 → 覆蓋率 gate 判定 FAIL。請在模組加入 jacoco-maven-plugin" +
      "（prepare-agent + report 綁定 test phase），或設 UT_JACOCO_XML 指定報告路徑";
    const looseMsg =
      "，略過覆蓋率 gate。建議加入 jacoco plugin，或設 UT_STRICT_COV=1 強制要求";
    return {
      passed: !STRICT_COV,
      report: `（${why}${STRICT_COV ? strictMsg : looseMsg}。）`,
    };
  }
  log(`解析覆蓋率報告：${xmlPath}`);
  const xml = fs.readFileSync(xmlPath, "utf8");
  const pkgOf = (cls: string): string | undefined => {
    try {
      const src = fs.readFileSync(path.resolve(REPO_ROOT, cls), "utf8");
      return /^\s*package\s+([\w.]+)\s*;/m.exec(src)?.[1].replace(/\./g, "/");
    } catch {
      return undefined;
    }
  };
  const { passed, lines } = parseJacocoReport(xml, targetClasses, undefined, pkgOf);
  return { passed, report: `覆蓋率檢查（${xmlPath}）：\n${lines.join("\n")}` };
}
