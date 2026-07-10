// Tool version stamp: "<package version> (<git short SHA | no-git>)".
// Mitigates central-clone reproducibility loss — every run records which tool built it.
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TESTGEN_ROOT } from "../config";

export function getToolVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(TESTGEN_ROOT, "package.json"), "utf8"));
  const pkgVersion = pkg.version ?? "0.0.0";
  let sha = "no-git";
  try {
    sha = execSync("git rev-parse --short HEAD", {
      cwd: TESTGEN_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    // not a git clone — keep "no-git"
  }
  return `${pkgVersion} (${sha})`;
}
