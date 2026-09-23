// The target module's test stack, measured: which test framework, which Mockito and what it can
// do, which assertion libraries, which Java language level. Injected into the writer's prompt as
// fact, like the conventions in libs/conventions.ts.
//
// The standards describe one stack — JUnit 5, MockitoExtension, AssertJ — and department repos
// run several. A JUnit-4-only module (Spring Boot before 2.2) rejects every JUnit 5 import; one
// without mockito-junit-jupiter has no MockitoExtension; without the inline mock maker,
// mockStatic compiles and then fails at runtime. Each of those is a compile or test failure the
// writer meets one round at a time, and the prompt it is fixing against says to do exactly what
// failed. The module already knows the answer: surefire records the test classpath of every run.
//
// What is said as fact has to be fact: a wrong "there is no Mockito" is worse than silence. So a
// classpath is only trusted when it is the test classpath (not the Maven JVM's own, which surefire
// before 2.21 records instead) and is not older than the poms that declare it; anything read off a
// pom is labelled as declared or inferred, never as absent.
import * as fs from "node:fs";
import * as path from "node:path";
import { ModuleInfo } from "./types";

export interface TestStack {
  /**
   * "surefire": the classpath of a test run — absence means absent.
   * "pom": declared dependencies only — absence means undeclared, which proves nothing, since
   * most of a test stack arrives transitively (spring-boot-starter-test brings all of it).
   */
  source: "surefire" | "pom";
  junit5?: string;
  junit4?: string;
  testng?: string;
  mockito?: string;
  mockitoJupiter?: boolean;
  /**
   * The inline mock maker: final classes and methods can be mocked, and static methods too from
   * Mockito 3.4 (Mockito.mockStatic). mockito-inline, Mockito 5+, or the mock-maker-inline switch;
   * a mock-maker-subclass switch turns it off again on Mockito 5.
   */
  mockitoInline?: boolean;
  assertj?: string;
  hamcrest?: string;
  /** hamcrest-core alone: CoreMatchers and MatcherAssert, but no org.hamcrest.Matchers. */
  hamcrestCoreOnly?: boolean;
  powermock?: string;
  /** "8", "11", "17"… — the level test sources compile at. */
  javaRelease?: string;
  /** The compiler's own log line wins over the pom: it reflects testRelease, profiles, maven.config. */
  javaReleaseFrom?: "log" | "pom";
  /** Existing test files per framework — the one surefire actually runs when several are present. */
  usage?: { junit5: number; junit4: number; testng: number };
  /** Facts the pom only implies (from the Spring Boot version), said as such in the prompt. */
  inferred?: string[];
  /** The pom chain ends at this parent outside the repo, whose dependency management is unknown. */
  unknownParent?: string;
}

export const majorOf = (version: string | undefined): number => Number(/^(\d+)/.exec(version ?? "")?.[1] ?? NaN);
export const minorOf = (version: string | undefined): number => Number(/^\d+\.(\d+)/.exec(version ?? "")?.[1] ?? NaN);

/** Pure: is `version` known and at least major.minor? Unknown is never "at least". */
export function versionAtLeast(version: string | undefined, major: number, minor: number): boolean {
  const a = majorOf(version);
  const b = minorOf(version);
  if (!Number.isFinite(a)) return false;
  return a > major || (a === major && (Number.isFinite(b) ? b : 0) >= minor);
}

/** Static mocking needs both the inline mock maker and the mockStatic API (Mockito 3.4). */
export function canMockStatic(stack: TestStack): boolean {
  return !!stack.mockitoInline && versionAtLeast(stack.mockito, 3, 4);
}

// ─── Surefire: the classpath of a real run ───────────────────────────────────

const JAR_PATTERNS: Array<[keyof TestStack, RegExp]> = [
  ["junit5", /(?:^|[\\/])junit-jupiter-api-(\d[\w.-]*?)\.jar$/],
  ["junit4", /(?:^|[\\/])junit-(4\.[\w.-]*?)\.jar$/],
  ["testng", /(?:^|[\\/])testng-(\d[\w.-]*?)\.jar$/],
  ["mockito", /(?:^|[\\/])mockito-(?:core|all)-(\d[\w.-]*?)\.jar$/],
  ["assertj", /(?:^|[\\/])assertj-core-(\d[\w.-]*?)\.jar$/],
  ["powermock", /(?:^|[\\/])powermock-(?:core|api-mockito2?|module-junit4)-(\d[\w.-]*?)\.jar$/],
];
// Hamcrest 2 is one jar ("hamcrest-2.2.jar"); 1.x split it, and hamcrest-core — what JUnit 4 pulls
// in — has no org.hamcrest.Matchers.
const HAMCREST_FULL = /(?:^|[\\/])hamcrest(?:-library|-all)?-(\d[\w.-]*?)\.jar$/;
const HAMCREST_CORE = /(?:^|[\\/])hamcrest-core-(\d[\w.-]*?)\.jar$/;

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

/**
 * Pure: the test classpath recorded in a surefire XML report, or [] when there is none.
 * surefire.test.class.path exists from surefire 2.21. Before that the report holds the Maven JVM's
 * own properties, whose java.class.path is Maven's plexus-classworlds boot jar — read as a test
 * classpath it said "no Mockito, no AssertJ" about modules that have both. java.class.path is only
 * the test classpath when it contains the module's test-classes.
 */
export function classpathFromSurefireXml(xml: string): string[] {
  for (const prop of ["surefire.test.class.path", "java.class.path"]) {
    const m = new RegExp(`<property\\s+name="${prop.replace(/\./g, "\\.")}"\\s+value="([^"]*)"`).exec(xml);
    if (!m) continue;
    const value = decodeXml(m[1]);
    // Windows separates with ';' and has ':' in every drive letter; POSIX uses ':'.
    const entries = value.split(value.includes(";") ? ";" : ":").filter(Boolean);
    if (!entries.some((e) => e.endsWith(".jar"))) continue;
    if (prop === "java.class.path" && !entries.some((e) => /[\\/]test-classes[\\/]?$/.test(e))) continue;
    return entries;
  }
  return [];
}

/** Pure: the stack a classpath adds up to; undefined when it holds no test framework at all. */
export function stackFromClasspath(entries: string[]): TestStack | undefined {
  const stack: TestStack = { source: "surefire" };
  let hamcrestCore: string | undefined;
  for (const entry of entries) {
    for (const [key, re] of JAR_PATTERNS) {
      const m = re.exec(entry);
      if (m && stack[key] === undefined) (stack as unknown as Record<string, string>)[key] = m[1];
    }
    const full = HAMCREST_FULL.exec(entry);
    if (full && stack.hamcrest === undefined) stack.hamcrest = full[1];
    const core = HAMCREST_CORE.exec(entry);
    if (core) hamcrestCore ??= core[1];
    if (/(?:^|[\\/])mockito-junit-jupiter-\d[\w.-]*\.jar$/.test(entry)) stack.mockitoJupiter = true;
    if (/(?:^|[\\/])mockito-inline-\d[\w.-]*\.jar$/.test(entry)) stack.mockitoInline = true;
  }
  // A classpath without a test framework is not a test classpath: say nothing rather than
  // "no Mockito, no AssertJ".
  if (stack.junit5 === undefined && stack.junit4 === undefined && stack.testng === undefined) return undefined;
  if (stack.hamcrest === undefined && hamcrestCore !== undefined) {
    stack.hamcrest = hamcrestCore;
    stack.hamcrestCoreOnly = true;
  }
  if (stack.mockito !== undefined) {
    stack.mockitoJupiter ??= false;
    // Mockito 5 made the inline mock maker the default.
    stack.mockitoInline ??= majorOf(stack.mockito) >= 5;
  }
  return stack;
}

// Reports can be large (captured stdout); the properties block comes first.
const XML_HEAD_BYTES = 2 * 1024 * 1024;

function readHead(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** The newest acceptable surefire report of the module that records a test classpath. */
function surefireClasspath(moduleRoot: string, accept: (mtimeMs: number) => boolean): string[] {
  const dir = path.join(moduleRoot, "target", "surefire-reports");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => /^TEST-.*\.xml$/.test(f));
  } catch {
    return [];
  }
  const dated = files
    .map((f) => {
      try {
        const st = fs.statSync(path.join(dir, f));
        return st.isFile() ? { f, t: st.mtimeMs } : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((x): x is { f: string; t: number } => !!x && accept(x.t))
    .sort((a, b) => b.t - a.t);
  for (const { f } of dated.slice(0, 5)) {
    try {
      const entries = classpathFromSurefireXml(readHead(path.join(dir, f), XML_HEAD_BYTES));
      if (entries.length) return entries;
    } catch {
      /* unreadable report: try the next */
    }
  }
  return [];
}

// ─── pom: declared, not resolved ─────────────────────────────────────────────

export interface PomFacts {
  properties: Record<string, string>;
  dependencies: Array<{ groupId: string; artifactId: string; version?: string; exclusions: string[] }>;
  springBootVersion?: string;
  /** maven-compiler-plugin configuration of the nearest pom that sets it. */
  compiler: { release?: string; testRelease?: string; source?: string; target?: string; encoding?: string };
  artifactId?: string;
  /** The top of the in-repo chain inherits from a parent that is not in the repo. */
  externalParent?: string;
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1];

// Comments, and profiles: a profile's properties and dependencies apply only when it is active,
// which the pom alone does not say — and read first, they won over the project's own.
function effectivePom(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<profiles>[\s\S]*?<\/profiles>/g, "");
}

/** Pure: the parent block of a pom. */
function parentOf(xml: string): { artifactId?: string; version?: string; relativePath?: string } | undefined {
  const m = /<parent>([\s\S]*?)<\/parent>/.exec(xml);
  if (!m) return undefined;
  const rel = /<relativePath\s*\/>|<relativePath>\s*([^<]*?)\s*<\/relativePath>/.exec(m[1]);
  return {
    artifactId: tag(m[1], "artifactId"),
    version: tag(m[1], "version"),
    relativePath: rel ? (rel[1] ?? "") : undefined,
  };
}

/** Pure: a property value with ${…} references resolved against the chain's properties. */
export function resolvePomValue(facts: PomFacts, v: string | undefined): string | undefined {
  let out = v;
  for (let depth = 0; out && /\$\{[^}]+\}/.test(out) && depth < 10; depth++) {
    out = out.replace(/\$\{([^}]+)\}/g, (whole, k: string) => facts.properties[k] ?? whole);
  }
  return out && !/\$\{/.test(out) ? out : undefined;
}

/**
 * Pure: facts from a chain of pom texts, nearest first (module, then its parents). Child values
 * win over parent ones, as Maven's inheritance does.
 */
export function pomFactsFromChain(chain: string[]): PomFacts {
  const facts: PomFacts = { properties: {}, dependencies: [], compiler: {} };
  const poms = chain.map(effectivePom);
  for (let i = poms.length - 1; i >= 0; i--) {
    const props = /<properties>([\s\S]*?)<\/properties>/.exec(poms[i])?.[1] ?? "";
    for (const m of props.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) facts.properties[m[1]] = m[2];
  }
  const resolve = (v: string | undefined) => resolvePomValue(facts, v);
  const own = poms[0] ?? "";
  facts.artifactId = tag(own.replace(/<parent>[\s\S]*?<\/parent>/, ""), "artifactId");
  for (const pom of poms) {
    // Only <dependencies> the project actually has: dependencyManagement only pins versions, and a
    // plugin's own dependencies are not on the test classpath.
    const body = pom
      .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "")
      .replace(/<plugin>[\s\S]*?<\/plugin>/g, "");
    for (const m of body.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const exclusionsXml = /<exclusions>([\s\S]*?)<\/exclusions>/.exec(m[1])?.[1] ?? "";
      const own = m[1].replace(/<exclusions>[\s\S]*?<\/exclusions>/, "");
      const groupId = resolve(tag(own, "groupId")) ?? "";
      const artifactId = resolve(tag(own, "artifactId")) ?? "";
      if (!artifactId || facts.dependencies.some((d) => d.groupId === groupId && d.artifactId === artifactId)) continue;
      const exclusions = [...exclusionsXml.matchAll(/<artifactId>\s*([^<]*?)\s*<\/artifactId>/g)].map((x) => x[1]);
      facts.dependencies.push({ groupId, artifactId, version: resolve(tag(own, "version")), exclusions });
    }
  }
  for (const pom of poms) {
    const parent = parentOf(pom);
    if (parent?.artifactId === "spring-boot-starter-parent" && parent.version) {
      facts.springBootVersion ??= resolve(parent.version);
    }
    const bom = /<dependency>\s*(?:(?!<\/dependency>)[\s\S])*?<artifactId>spring-boot-dependencies<\/artifactId>(?:(?!<\/dependency>)[\s\S])*?<\/dependency>/.exec(pom);
    if (bom) facts.springBootVersion ??= resolve(tag(bom[0], "version"));
  }
  const top = parentOf(poms[poms.length - 1] ?? "");
  if (top?.artifactId) facts.externalParent = top.artifactId;
  for (const pom of poms) {
    const plugin = /<plugin>(?:(?!<\/plugin>)[\s\S])*?<artifactId>maven-compiler-plugin<\/artifactId>(?:(?!<\/plugin>)[\s\S])*?<\/plugin>/.exec(pom)?.[0];
    const conf = plugin ? (/<configuration>([\s\S]*?)<\/configuration>/.exec(plugin)?.[1] ?? "") : "";
    for (const key of ["release", "testRelease", "source", "target", "encoding"] as const) {
      facts.compiler[key] ??= resolve(tag(conf, key));
    }
  }
  return facts;
}

/** The module's pom and its parents that live in the repo, nearest first. */
export function readPomChain(moduleRoot: string, repoRoot: string): Array<{ path: string; xml: string }> {
  const chain: Array<{ path: string; xml: string }> = [];
  let pomPath = path.join(moduleRoot, "pom.xml");
  const root = path.resolve(repoRoot);
  for (let depth = 0; depth < 10; depth++) {
    let xml: string;
    try {
      if (!fs.statSync(pomPath).isFile()) break;
      xml = fs.readFileSync(pomPath, "utf8");
    } catch {
      break;
    }
    chain.push({ path: pomPath, xml });
    const parent = parentOf(effectivePom(xml));
    if (!parent || parent.relativePath === "") break;
    let next = path.resolve(path.dirname(pomPath), parent.relativePath ?? "..");
    if (!next.endsWith(".xml")) next = path.join(next, "pom.xml");
    const rel = path.relative(root, next);
    if (rel.startsWith("..") || path.isAbsolute(rel)) break;
    // A parent pom that is not the declared parent (a reactor whose modules inherit from an
    // external parent) contributes nothing to inheritance.
    let parentXml = "";
    try {
      parentXml = effectivePom(fs.readFileSync(next, "utf8"));
    } catch {
      break;
    }
    if (parent.artifactId && tag(parentXml.replace(/<parent>[\s\S]*?<\/parent>/, ""), "artifactId") !== parent.artifactId) break;
    pomPath = next;
  }
  return chain;
}

/**
 * What spring-boot-starter-test brings, per Boot line — read from each line's
 * spring-boot-dependencies pom (junit.version, junit-jupiter.version, mockito.version,
 * assertj.version) and starter-test's own dependencies: JUnit 4 only before 2.2, JUnit 5 with the
 * vintage engine (so JUnit 4 as well) in 2.2–2.3, JUnit 5 only from 2.4; mockito-junit-jupiter from
 * 2.2; AssertJ from 1.4. Lines newer than the table inherit its last row's majors, without versions.
 */
const BOOT_LINES: Array<{ line: [number, number]; junit4?: string; junit5?: string; mockito: string; assertj?: string }> = [
  { line: [1, 0], junit4: "4.12", mockito: "1.10.19" },
  { line: [1, 4], junit4: "4.12", mockito: "1.10.19", assertj: "2.5.0" },
  { line: [1, 5], junit4: "4.12", mockito: "1.10.19", assertj: "2.6.0" },
  { line: [2, 0], junit4: "4.12", mockito: "2.15.0", assertj: "3.9.1" },
  { line: [2, 1], junit4: "4.12", mockito: "2.23.4", assertj: "3.11.1" },
  { line: [2, 2], junit4: "4.12", junit5: "5.5.2", mockito: "3.1.0", assertj: "3.13.2" },
  { line: [2, 3], junit4: "4.13.2", junit5: "5.6.3", mockito: "3.3.3", assertj: "3.16.1" },
  { line: [2, 4], junit5: "5.7.2", mockito: "3.6.28", assertj: "3.18.1" },
  { line: [2, 5], junit5: "5.7.2", mockito: "3.9.0", assertj: "3.19.0" },
  { line: [2, 6], junit5: "5.8.2", mockito: "4.0.0", assertj: "3.21.0" },
  { line: [2, 7], junit5: "5.8.2", mockito: "4.5.1", assertj: "3.22.0" },
  { line: [3, 0], junit5: "5.9.3", mockito: "4.8.1", assertj: "3.23.1" },
  { line: [3, 1], junit5: "5.9.3", mockito: "5.3.1", assertj: "3.24.2" },
  { line: [3, 2], junit5: "5.10.5", mockito: "5.7.0", assertj: "3.24.2" },
  { line: [3, 3], junit5: "5.10.5", mockito: "5.11.0", assertj: "3.25.3" },
  { line: [3, 4], junit5: "5.11.4", mockito: "5.14.2", assertj: "3.26.3" },
];

/** Pure: the Boot line's row, or undefined for a version that is not a release number. */
export function bootLine(version: string): (typeof BOOT_LINES)[number] | undefined {
  if (!Number.isFinite(majorOf(version))) return undefined;
  let row: (typeof BOOT_LINES)[number] | undefined;
  for (const r of BOOT_LINES) if (versionAtLeast(version, r.line[0], r.line[1])) row = r;
  if (!row) return undefined;
  const last = BOOT_LINES[BOOT_LINES.length - 1];
  // Newer than the table: same frameworks, versions unknown except their major.
  if (row === last && !(majorOf(version) === last.line[0] && minorOf(version) === last.line[1])) {
    return { line: last.line, junit5: "5", mockito: "5", assertj: "3" };
  }
  return row;
}

/** Pure: the declared stack. Only what is declared or directly implied is said. */
export function stackFromPom(facts: PomFacts): TestStack | undefined {
  const stack: TestStack = { source: "pom", inferred: [] };
  const dep = (artifactId: string | RegExp) =>
    facts.dependencies.find((d) => (typeof artifactId === "string" ? d.artifactId === artifactId : artifactId.test(d.artifactId)));
  const version = (d: { version?: string } | undefined) => d?.version ?? "";
  const j5 = dep(/^junit-jupiter(-api|-engine)?$/);
  if (j5) stack.junit5 = version(j5);
  const j4 = facts.dependencies.find((d) => d.groupId === "junit" && d.artifactId === "junit");
  if (j4) stack.junit4 = version(j4);
  const testng = dep("testng");
  if (testng) stack.testng = version(testng);
  const mockito = dep(/^mockito-(core|all)$/);
  if (mockito) stack.mockito = version(mockito);
  if (dep("mockito-junit-jupiter")) stack.mockitoJupiter = true;
  if (dep("mockito-inline") || majorOf(mockito?.version) >= 5) stack.mockitoInline = true;
  const assertj = dep("assertj-core");
  if (assertj) stack.assertj = version(assertj);
  const hamcrestFull = dep(/^hamcrest(-library|-all)?$/);
  const hamcrestCore = dep("hamcrest-core");
  if (hamcrestFull) stack.hamcrest = version(hamcrestFull);
  else if (hamcrestCore) {
    stack.hamcrest = version(hamcrestCore);
    stack.hamcrestCoreOnly = true;
  }
  const powermock = dep(/^powermock-/);
  if (powermock) stack.powermock = version(powermock);
  const bootTest = dep("spring-boot-starter-test");
  const boot = facts.springBootVersion;
  const row = bootTest && boot ? bootLine(boot) : undefined;
  if (bootTest && boot && row) {
    // Boot lets a pom override a managed version through these properties.
    const p = facts.properties;
    const excluded = new Set(bootTest.exclusions);
    if (row.junit5 !== undefined && !excluded.has("junit-jupiter")) {
      stack.junit5 ??= p["junit-jupiter.version"] ?? row.junit5;
      stack.mockitoJupiter ??= !excluded.has("mockito-junit-jupiter");
      stack.inferred!.push(`Spring Boot ${boot} 的 spring-boot-starter-test 帶有 JUnit 5 與 mockito-junit-jupiter`);
    }
    // 2.2–2.3 reach JUnit 4 through the vintage engine, which Initializr's poms exclude.
    const vintage = row.junit5 !== undefined;
    const has4 = row.junit4 !== undefined && !excluded.has(vintage ? "junit-vintage-engine" : "junit");
    if (has4) {
      stack.junit4 ??= p["junit.version"] ?? row.junit4;
      stack.inferred!.push(
        row.junit5 !== undefined
          ? `Spring Boot ${boot} 的 spring-boot-starter-test 也帶有 JUnit 4（vintage engine）`
          : `Spring Boot ${boot} 的 spring-boot-starter-test 只帶 JUnit 4 ${stack.junit4}，沒有 JUnit 5`,
      );
    }
    if (!excluded.has("mockito-core")) stack.mockito ??= p["mockito.version"] ?? row.mockito;
    if (row.assertj !== undefined && !excluded.has("assertj-core")) stack.assertj ??= p["assertj.version"] ?? row.assertj;
    if (stack.mockito !== undefined && majorOf(stack.mockito) >= 5) stack.mockitoInline ??= true;
  }
  // A parent outside the repo can manage and add anything; a Boot parent is only known when named.
  if (facts.externalParent && facts.externalParent !== "spring-boot-starter-parent") stack.unknownParent = facts.externalParent;
  const any = Object.keys(stack).some((k) => !["source", "inferred", "unknownParent"].includes(k));
  if (!stack.inferred!.length) delete stack.inferred;
  return any ? stack : undefined;
}

// ─── Java language level ─────────────────────────────────────────────────────

/**
 * Pure: the level the module's test sources were compiled at, from maven-compiler-plugin's own
 * log line ("Compiling 3 source files with javac [debug release 17] to target/test-classes", with
 * "module-path" or other tokens after the level on some versions), attributed to the module by the
 * "--- ... @ <artifactId> ---" header before it. undefined when the build compiled nothing (up to
 * date) or the plugin is too old to print the level.
 */
export function javaReleaseFromLog(log: string, artifactId: string | undefined): string | undefined {
  let current: string | undefined;
  let found: string | undefined;
  for (const line of log.split(/\r?\n/)) {
    const header = /--- \S.*? @ (\S+) ---/.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    const m = /Compiling \d+ source files?\b.*?\[[^\]]*?\b(?:release|target) (\d[\w.]*)[^\]]*\]/.exec(line);
    if (m && (!artifactId || current === artifactId)) {
      found = m[1];
      if (/test-classes/.test(line)) return found;
    }
  }
  return found;
}

function normalizeRelease(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = /^1\.(\d+)$/.exec(v.trim());
  return m ? m[1] : v.trim();
}

function releaseFromPom(facts: PomFacts): string | undefined {
  const p = facts.properties;
  return normalizeRelease(
    facts.compiler.testRelease ??
      p["maven.compiler.testRelease"] ??
      facts.compiler.release ??
      p["maven.compiler.release"] ??
      facts.compiler.target ??
      p["maven.compiler.target"] ??
      facts.compiler.source ??
      p["maven.compiler.source"] ??
      // Spring Boot's parent compiles at ${java.version}.
      (facts.springBootVersion ? p["java.version"] : undefined),
  );
}

// ─── Existing tests ──────────────────────────────────────────────────────────

const USAGE_SAMPLE = 300;

/** Test files per framework, from their imports — a sample is enough to see which one dominates. */
function frameworkUsage(testRoot: string): { junit5: number; junit4: number; testng: number } {
  const usage = { junit5: 0, junit4: 0, testng: 0 };
  let seen = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen >= USAGE_SAMPLE) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".java")) {
        seen++;
        let src = "";
        try {
          src = fs.readFileSync(p, "latin1");
        } catch {
          continue;
        }
        if (/^\s*import\s+(?:static\s+)?org\.testng\./m.test(src)) usage.testng++;
        else if (/^\s*import\s+(?:static\s+)?org\.junit\.jupiter\./m.test(src)) usage.junit5++;
        else if (/^\s*import\s+(?:static\s+)?org\.junit\.(?!jupiter\.|platform\.)/m.test(src)) usage.junit4++;
      }
    }
  };
  walk(testRoot);
  return usage;
}

/** mockito-extensions/org.mockito.plugins.MockMaker: which mock maker the module switches to. */
function mockMakerSwitch(moduleRoot: string): "inline" | "subclass" | undefined {
  const file = path.join(moduleRoot, "src", "test", "resources", "mockito-extensions", "org.mockito.plugins.MockMaker");
  let value = "";
  try {
    value = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  if (/mock-maker-inline|InlineByteBuddyMockMaker/.test(value)) return "inline";
  if (/mock-maker-subclass|SubclassByteBuddyMockMaker|ByteBuddyMockMaker/.test(value)) return "subclass";
  return undefined;
}

// ─── Measurement ─────────────────────────────────────────────────────────────

/**
 * The module's test stack: the classpath of its latest surefire run when that run is current, the
 * pom's declarations otherwise, undefined when neither says anything. A report is current when it
 * was written at or after `since` (the build that just ran), or after every pom in the chain was
 * last changed — an older one describes dependencies the pom may no longer declare. `buildLog` is
 * the latest build's output, read for the compiler's language level.
 */
export function measureTestStack(mod: ModuleInfo, repoRoot: string, buildLog = "", since?: number): TestStack | undefined {
  let facts: PomFacts | undefined;
  let pomNewest = 0;
  try {
    const chain = readPomChain(mod.moduleRoot, repoRoot);
    facts = chain.length ? pomFactsFromChain(chain.map((c) => c.xml)) : undefined;
    for (const c of chain) pomNewest = Math.max(pomNewest, fs.statSync(c.path).mtimeMs);
  } catch {
    facts = undefined;
  }
  // Timestamps from the same clock can still differ by a filesystem's resolution.
  const accept = (t: number) => (since !== undefined && t >= since - 2000) || (pomNewest > 0 && t > pomNewest);
  const cp = surefireClasspath(mod.moduleRoot, accept);
  const stack: TestStack = (cp.length ? stackFromClasspath(cp) : undefined) ?? (facts ? stackFromPom(facts) : undefined) ?? {
    source: "pom",
  };
  if (stack.mockito !== undefined) {
    const maker = mockMakerSwitch(mod.moduleRoot);
    if (maker === "inline") stack.mockitoInline = true;
    if (maker === "subclass") stack.mockitoInline = false;
  }
  const fromLog = normalizeRelease(javaReleaseFromLog(buildLog, facts?.artifactId));
  const fromPom = facts ? releaseFromPom(facts) : undefined;
  if (fromLog) {
    stack.javaRelease = fromLog;
    stack.javaReleaseFrom = "log";
  } else if (fromPom) {
    stack.javaRelease = fromPom;
    stack.javaReleaseFrom = "pom";
  }
  // Several frameworks, or a declared one that a parent outside the repo may add JUnit 5 to: the
  // module's existing tests show which one its build runs.
  const frameworks = [stack.junit5, stack.junit4, stack.testng].filter((f) => f !== undefined).length;
  const unsettled = stack.source === "pom" && !!stack.unknownParent && stack.junit5 === undefined && frameworks > 0;
  if (frameworks > 1 || unsettled) stack.usage = frameworkUsage(path.join(mod.moduleRoot, "src", "test", "java"));
  return Object.keys(stack).length > 1 ? stack : undefined;
}

/**
 * Pure: the newer measurement where it is better, keeping what only the older one knew — above all
 * a language level read off the compiler's own log, which a later pom reading must not replace.
 */
export function mergeTestStack(prev: TestStack | undefined, next: TestStack | undefined): TestStack | undefined {
  if (!next) return prev;
  if (!prev) return next;
  // A pom reading never replaces a classpath measurement; a newer measurement replaces an older one.
  const base: TestStack = prev.source === "surefire" && next.source === "pom" ? { ...prev } : { ...next };
  // The language level: a compiler log line over a pom value, the newer log line over the older.
  const level =
    next.javaReleaseFrom === "log" ? next : prev.javaReleaseFrom === "log" ? prev : next.javaRelease ? next : prev;
  if (level.javaRelease) {
    base.javaRelease = level.javaRelease;
    base.javaReleaseFrom = level.javaReleaseFrom;
  }
  return base;
}

/** Pure: one log line — what was measured and from where. */
export function describeTestStack(stack: TestStack | undefined): string {
  if (!stack) return "量不到（沒有可採用的 surefire 報告，pom 也沒有宣告可辨識的測試相依）";
  const v = (x: string | undefined) => (x ? ` ${x}` : "");
  const parts: string[] = [];
  if (stack.junit5 !== undefined) parts.push(`JUnit 5${v(stack.junit5)}`);
  if (stack.junit4 !== undefined) parts.push(`JUnit 4${v(stack.junit4)}`);
  if (stack.testng !== undefined) parts.push(`TestNG${v(stack.testng)}`);
  if (stack.mockito !== undefined) {
    const caps = [
      stack.mockitoJupiter === undefined ? "" : `MockitoExtension ${stack.mockitoJupiter ? "可用" : "不可用"}`,
      stack.mockitoInline === undefined ? "" : `final mock ${stack.mockitoInline ? "可用" : "不可用"}`,
      stack.mockitoInline === undefined ? "" : `static mock ${canMockStatic(stack) ? "可用" : "不可用"}`,
    ].filter(Boolean);
    parts.push(`Mockito${v(stack.mockito)}${caps.length ? `（${caps.join("、")}）` : ""}`);
  }
  if (stack.assertj !== undefined) parts.push(`AssertJ${v(stack.assertj)}`);
  if (stack.hamcrest !== undefined) parts.push(`Hamcrest${v(stack.hamcrest)}${stack.hamcrestCoreOnly ? "（只有 core）" : ""}`);
  if (stack.powermock !== undefined) parts.push(`PowerMock${v(stack.powermock)}`);
  if (stack.javaRelease) parts.push(`Java ${stack.javaRelease}`);
  const from = stack.source === "surefire" ? "surefire 測試 classpath" : "pom 宣告（未經建置確認）";
  return `${parts.join("、") || "（沒有可辨識的測試相依）"}——來源：${from}`;
}
