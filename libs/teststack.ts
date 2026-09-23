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
import * as fs from "node:fs";
import * as path from "node:path";
import { ModuleInfo } from "./types";

export interface TestStack {
  /**
   * "surefire": the classpath of a test run that happened — absence means absent.
   * "pom": declared dependencies only — absence means undeclared, which proves nothing, since
   * most of a test stack arrives transitively (spring-boot-starter-test brings all of it).
   */
  source: "surefire" | "pom";
  junit5?: string;
  junit4?: string;
  testng?: string;
  mockito?: string;
  mockitoJupiter?: boolean;
  /** Static and final mocking: mockito-inline, Mockito 5+, or the mock-maker-inline switch. */
  mockitoInline?: boolean;
  assertj?: string;
  hamcrest?: string;
  powermock?: string;
  springBootTest?: string;
  /** "8", "11", "17"… — the level test sources compile at. */
  javaRelease?: string;
  /** Facts the pom only implies (from the Spring Boot version), said as such in the prompt. */
  inferred?: string[];
}

// ─── Surefire: the classpath of a real run ───────────────────────────────────

const JAR_PATTERNS: Array<[keyof TestStack, RegExp]> = [
  ["junit5", /(?:^|[\\/])junit-jupiter-api-(\d[\w.-]*?)\.jar$/],
  ["junit4", /(?:^|[\\/])junit-(4\.[\w.-]*?)\.jar$/],
  ["testng", /(?:^|[\\/])testng-(\d[\w.-]*?)\.jar$/],
  ["mockito", /(?:^|[\\/])mockito-(?:core|all)-(\d[\w.-]*?)\.jar$/],
  ["assertj", /(?:^|[\\/])assertj-core-(\d[\w.-]*?)\.jar$/],
  ["hamcrest", /(?:^|[\\/])hamcrest(?:-core|-library|-all)?-(\d[\w.-]*?)\.jar$/],
  ["powermock", /(?:^|[\\/])powermock-(?:core|api-mockito2?|module-junit4)-(\d[\w.-]*?)\.jar$/],
  ["springBootTest", /(?:^|[\\/])spring-boot-test-(\d[\w.-]*?)\.jar$/],
];

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

/** Pure: the test classpath entries recorded in a surefire XML report, or [] when there are none. */
export function classpathFromSurefireXml(xml: string): string[] {
  // surefire.test.class.path is the test classpath proper; java.class.path is the booter jar
  // unless forking without a manifest-only jar, so it only counts when it lists jars.
  for (const prop of ["surefire.test.class.path", "java.class.path"]) {
    const m = new RegExp(`<property\\s+name="${prop.replace(/\./g, "\\.")}"\\s+value="([^"]*)"`).exec(xml);
    if (!m) continue;
    const value = decodeXml(m[1]);
    // Windows separates with ';' and has ':' in every drive letter; POSIX uses ':'.
    const entries = value.split(value.includes(";") ? ";" : ":").filter(Boolean);
    if (entries.some((e) => e.endsWith(".jar"))) return entries;
  }
  return [];
}

/** Pure: the stack a classpath adds up to. */
export function stackFromClasspath(entries: string[]): TestStack {
  const stack: TestStack = { source: "surefire" };
  for (const entry of entries) {
    for (const [key, re] of JAR_PATTERNS) {
      const m = re.exec(entry);
      if (m && stack[key] === undefined) (stack as unknown as Record<string, string>)[key] = m[1];
    }
    if (/(?:^|[\\/])mockito-junit-jupiter-\d[\w.-]*\.jar$/.test(entry)) stack.mockitoJupiter = true;
    if (/(?:^|[\\/])mockito-inline-\d[\w.-]*\.jar$/.test(entry)) stack.mockitoInline = true;
  }
  if (stack.mockito) {
    stack.mockitoJupiter ??= false;
    // Mockito 5 made the inline mock maker the default.
    stack.mockitoInline ??= majorOf(stack.mockito) >= 5;
  }
  return stack;
}

function majorOf(version: string): number {
  return Number(/^(\d+)/.exec(version)?.[1] ?? 0);
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

/** The newest surefire report of the module that records a classpath. */
function surefireClasspath(moduleRoot: string): string[] {
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
    .filter((x): x is { f: string; t: number } => !!x)
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
  dependencies: Array<{ groupId: string; artifactId: string; version?: string }>;
  springBootVersion?: string;
  /** maven-compiler-plugin configuration of the nearest pom that sets it. */
  compiler: { release?: string; source?: string; target?: string; encoding?: string };
  artifactId?: string;
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1];

function stripComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

/** Pure: the parent block, and the project's own coordinates outside it. */
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

/**
 * Pure: facts from a chain of pom texts, nearest first (module, then its parents). Child values
 * win over parent ones, as Maven's inheritance does.
 */
export function pomFactsFromChain(chain: string[]): PomFacts {
  const facts: PomFacts = { properties: {}, dependencies: [], compiler: {} };
  const poms = chain.map(stripComments);
  for (let i = poms.length - 1; i >= 0; i--) {
    const props = /<properties>([\s\S]*?)<\/properties>/.exec(poms[i])?.[1] ?? "";
    for (const m of props.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) facts.properties[m[1]] = m[2];
  }
  const resolve = (v: string | undefined): string | undefined => {
    let out = v;
    for (let depth = 0; out && /\$\{[^}]+\}/.test(out) && depth < 10; depth++) {
      out = out.replace(/\$\{([^}]+)\}/g, (whole, k: string) => facts.properties[k] ?? whole);
    }
    return out && !/\$\{/.test(out) ? out : undefined;
  };
  const own = poms[0] ?? "";
  facts.artifactId = tag(own.replace(/<parent>[\s\S]*?<\/parent>/, ""), "artifactId");
  for (const pom of poms) {
    // Only <dependencies> the project actually has: dependencyManagement only pins versions, and a
    // plugin's own dependencies are not on the test classpath.
    const body = pom
      .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "")
      .replace(/<plugin>[\s\S]*?<\/plugin>/g, "");
    for (const m of body.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const groupId = resolve(tag(m[1], "groupId")) ?? "";
      const artifactId = resolve(tag(m[1], "artifactId")) ?? "";
      if (!artifactId || facts.dependencies.some((d) => d.groupId === groupId && d.artifactId === artifactId)) continue;
      facts.dependencies.push({ groupId, artifactId, version: resolve(tag(m[1], "version")) });
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
  for (const pom of poms) {
    const plugin = /<plugin>(?:(?!<\/plugin>)[\s\S])*?<artifactId>maven-compiler-plugin<\/artifactId>(?:(?!<\/plugin>)[\s\S])*?<\/plugin>/.exec(pom)?.[0];
    const conf = plugin ? (/<configuration>([\s\S]*?)<\/configuration>/.exec(plugin)?.[1] ?? "") : "";
    for (const key of ["release", "source", "target", "encoding"] as const) {
      facts.compiler[key] ??= resolve(tag(conf, key));
    }
  }
  return facts;
}

/** The module's pom and its parents that live in the repo, nearest first. */
export function readPomChain(moduleRoot: string, repoRoot: string): string[] {
  const chain: string[] = [];
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
    chain.push(xml);
    const parent = parentOf(stripComments(xml));
    if (!parent || parent.relativePath === "") break;
    let next = path.resolve(path.dirname(pomPath), parent.relativePath ?? "..");
    if (!next.endsWith(".xml")) next = path.join(next, "pom.xml");
    const rel = path.relative(root, next);
    if (rel.startsWith("..") || path.isAbsolute(rel)) break;
    // A parent pom that is not the declared parent (a reactor whose modules inherit from an
    // external parent) contributes nothing to inheritance.
    let parentXml = "";
    try {
      parentXml = stripComments(fs.readFileSync(next, "utf8"));
    } catch {
      break;
    }
    if (parent.artifactId && tag(parentXml.replace(/<parent>[\s\S]*?<\/parent>/, ""), "artifactId") !== parent.artifactId) break;
    pomPath = next;
  }
  return chain;
}

function versionAtLeast(version: string, major: number, minor: number): boolean {
  const [a, b] = version.split(".").map((x) => Number(/^\d+/.exec(x)?.[0] ?? 0));
  return a > major || (a === major && (b ?? 0) >= minor);
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
  if (dep("mockito-inline") || (mockito?.version && majorOf(mockito.version) >= 5)) stack.mockitoInline = true;
  const assertj = dep("assertj-core");
  if (assertj) stack.assertj = version(assertj);
  const hamcrest = dep(/^hamcrest(-core|-library|-all)?$/);
  if (hamcrest) stack.hamcrest = version(hamcrest);
  const powermock = dep(/^powermock-/);
  if (powermock) stack.powermock = version(powermock);
  const bootTest = dep("spring-boot-starter-test");
  if (bootTest) {
    const boot = facts.springBootVersion;
    stack.springBootTest = boot ?? "";
    // What spring-boot-starter-test brings is fixed per Boot line: JUnit 4 only before 2.2, both
    // (through the vintage engine) in 2.2–2.3, JUnit 5 only from 2.4; Mockito's JUnit 5
    // extension and AssertJ with every line that has JUnit 5.
    if (boot && /^\d/.test(boot)) {
      const has5 = versionAtLeast(boot, 2, 2);
      const has4 = !versionAtLeast(boot, 2, 4);
      if (has5) {
        stack.junit5 ??= "";
        stack.mockitoJupiter ??= true;
        stack.inferred!.push(`Spring Boot ${boot} 的 spring-boot-starter-test 帶有 JUnit 5 與 mockito-junit-jupiter`);
      }
      if (has4) {
        stack.junit4 ??= "";
        stack.inferred!.push(
          has5
            ? `Spring Boot ${boot} 的 spring-boot-starter-test 也帶有 JUnit 4（vintage engine）`
            : `Spring Boot ${boot} 的 spring-boot-starter-test 只帶 JUnit 4，沒有 JUnit 5`,
        );
      }
      stack.assertj ??= "";
      stack.mockito ??= "";
    }
  }
  const any = Object.keys(stack).some((k) => !["source", "inferred"].includes(k));
  if (!stack.inferred!.length) delete stack.inferred;
  return any ? stack : undefined;
}

// ─── Java language level ─────────────────────────────────────────────────────

/**
 * Pure: the level the module's test sources were compiled at, from maven-compiler-plugin's own
 * log line ("Compiling 3 source files with javac [debug release 17] to target/test-classes"),
 * attributed to the module by the "--- ... @ <artifactId> ---" header before it. undefined when the
 * build compiled nothing (up to date) or the plugin is too old to print the level.
 */
export function javaReleaseFromLog(log: string, artifactId: string | undefined): string | undefined {
  let current: string | undefined;
  let found: string | undefined;
  for (const line of log.split(/\r?\n/)) {
    const header = /^\[INFO\] --- .*? @ (\S+) ---/.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    const m = /Compiling \d+ source files? (?:with javac )?\[[^\]]*?\b(?:release|target) (\S+?)\]/.exec(line);
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

// ─── Measurement ─────────────────────────────────────────────────────────────

/**
 * The module's test stack: the classpath of its latest surefire run when there is one, the pom's
 * declarations otherwise, undefined when neither says anything. `buildLog` is the latest build's
 * output, read for the compiler's language level.
 */
export function measureTestStack(mod: ModuleInfo, repoRoot: string, buildLog = ""): TestStack | undefined {
  let facts: PomFacts | undefined;
  try {
    facts = pomFactsFromChain(readPomChain(mod.moduleRoot, repoRoot));
  } catch {
    facts = undefined;
  }
  const cp = surefireClasspath(mod.moduleRoot);
  const stack: TestStack = (cp.length ? stackFromClasspath(cp) : facts ? stackFromPom(facts) : undefined) ?? {
    source: "pom",
  };
  // The switch that turns on the inline mock maker without the mockito-inline jar.
  if (stack.mockito !== undefined && !stack.mockitoInline) {
    const maker = path.join(mod.moduleRoot, "src", "test", "resources", "mockito-extensions", "org.mockito.plugins.MockMaker");
    try {
      if (/mock-maker-inline/.test(fs.readFileSync(maker, "utf8"))) stack.mockitoInline = true;
    } catch {
      /* no switch */
    }
  }
  stack.javaRelease = normalizeRelease(javaReleaseFromLog(buildLog, facts?.artifactId)) ?? (facts ? releaseFromPom(facts) : undefined);
  if (stack.javaRelease === undefined) delete stack.javaRelease;
  return Object.keys(stack).length > 1 ? stack : undefined;
}

/** Pure: one log line — what was measured and from where. */
export function describeTestStack(stack: TestStack | undefined): string {
  if (!stack) return "量不到（沒有 surefire 報告，pom 也沒有宣告可辨識的測試相依）";
  const v = (x: string | undefined) => (x ? ` ${x}` : "");
  const parts: string[] = [];
  if (stack.junit5 !== undefined) parts.push(`JUnit 5${v(stack.junit5)}`);
  if (stack.junit4 !== undefined) parts.push(`JUnit 4${v(stack.junit4)}`);
  if (stack.testng !== undefined) parts.push(`TestNG${v(stack.testng)}`);
  if (stack.mockito !== undefined) {
    const caps = [
      stack.mockitoJupiter === undefined ? "" : `MockitoExtension ${stack.mockitoJupiter ? "可用" : "不可用"}`,
      stack.mockitoInline === undefined ? "" : `static/final mock ${stack.mockitoInline ? "可用" : "不可用"}`,
    ].filter(Boolean);
    parts.push(`Mockito${v(stack.mockito)}${caps.length ? `（${caps.join("、")}）` : ""}`);
  }
  if (stack.assertj !== undefined) parts.push(`AssertJ${v(stack.assertj)}`);
  if (stack.hamcrest !== undefined) parts.push(`Hamcrest${v(stack.hamcrest)}`);
  if (stack.javaRelease) parts.push(`Java ${stack.javaRelease}`);
  const from = stack.source === "surefire" ? "surefire 測試 classpath" : "pom 宣告（未經建置確認）";
  return `${parts.join("、") || "（沒有可辨識的測試相依）"}——來源：${from}`;
}
