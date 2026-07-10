# Tool Commands — Counting, JaCoCo & PIT — v1.0

Reference for executing external tools from the skill. Use when the user has
selected `full` metric mode, or when Phase 1 needs a deterministic test count.

If tool execution fails, STOP and ask the user how to proceed — see SKILL.md
"Mode enforcement" section. **Never silently degrade to `qualitative-only`.**

---

## Critical clarification — `mvn test` does NOT need JaCoCo or PIT

This is the most common LLM misconception when running this skill.

| Command | Requires | Produces | Purpose |
|---------|----------|----------|---------|
| `mvn test` | Just Maven + pom.xml + tests | Pass/fail results via Surefire | Basic unit test execution |
| `mvn compile test-compile` | Same as above | Verifies build works | Pre-flight check |
| `mvn jacoco:report` | JaCoCo plugin declared | Line/branch coverage XML | Coverage signal (Dim 2) |
| `mvn org.pitest:pitest-maven:mutationCoverage` | PIT plugin declared | Mutation score XML | Effectiveness signal (Dim 1) |

**Key points:**

- **Surefire is built into Maven.** It is always available. `mvn test` works
  on any normal Maven project without additional plugins.
- **Missing JaCoCo** means no coverage XML. It does NOT mean Maven can't run tests.
- **Missing PIT** means no mutation score. It does NOT mean Maven can't run tests.

**Wrong LLM behavior to avoid:**

> "I looked at pom.xml and it has no JaCoCo plugin, so I can't run `full` mode.
> I'll proceed with qualitative-only."

This is incorrect. The correct behavior:
1. Attempt `mvn test -DskipTests=true` to verify Maven works at all
2. Report the missing plugins to the user
3. Ask whether to (a) add plugins, (b) use existing reports, or (c) downgrade

---

## Test method counting (deterministic)

**This is mandatory** — never let an LLM estimate test counts. Use one of
these three methods, in order of preference:

### Method A — AST parsing (most accurate)

Use `tree-sitter` or `javaparser`. Pseudocode:

```python
from tree_sitter import Language, Parser
# ... (language setup)
test_count = 0
for file in glob("src/test/java/**/*.java"):
    tree = parser.parse(file.read())
    for method in find_methods(tree):
        annotations = get_annotations(method)
        if any(a in TEST_ANNOTATIONS for a in annotations):
            if "Disabled" not in annotations and "Ignore" not in annotations:
                test_count += 1

TEST_ANNOTATIONS = {"Test", "ParameterizedTest", "RepeatedTest", "TestFactory"}
```

### Method B — grep (quick, ~95% accurate)

```bash
# Count all test-annotated methods, excluding disabled ones
grep -rE "^\s*@(Test|ParameterizedTest|RepeatedTest|TestFactory)(\(|$|\s)" \
  --include="*.java" src/test/java \
  | grep -v "@Disabled\|@Ignore" \
  | wc -l
```

**Limitations of grep**:
- Won't handle multi-line annotations
- May miss annotations in `@Nested` classes if oddly formatted
- Cannot distinguish commented-out code

If grep count differs from Method C by > 5%, fall back to AST.

### Method C — Maven Surefire cross-check

```bash
./mvnw test -Dtest='*' -DfailIfNoTests=false -DtestFailureIgnore=true | \
  grep -E "Running " | wc -l
```

This is the **ground truth** for "what Maven thinks are tests", but it takes
longer (runs test compilation). Use it as a cross-check, not primary source.

### Recommended flow

```
1. Count via grep (fast, ~5 sec)
2. Count via AST (slower, ~30 sec) — only if grep hits edge cases
3. Run Surefire listing once per repo (slow, ~1-2 min) — for validation
4. Log all three numbers in meta.caveats if they differ
```

---

## Detecting the build system

```bash
if [ -f "pom.xml" ]; then
  BUILD="maven"
elif [ -f "build.gradle" ] || [ -f "build.gradle.kts" ]; then
  BUILD="gradle"
else
  BUILD="unknown"
fi
```

If `unknown`, stop and ask the user.

Prefer `./mvnw` / `./gradlew` (wrappers) over system-installed `mvn` / `gradle`
to match the repo's pinned version.

---

## JaCoCo — Coverage

### Maven

Check `pom.xml` for `jacoco-maven-plugin`. If missing, the run below produces
no report. Do **not** edit `pom.xml`; fall back per Mode enforcement rules.

```bash
./mvnw clean test jacoco:report
```

Default report location:
```
target/site/jacoco/jacoco.xml       ← parse this
target/site/jacoco/index.html       ← human view
```

### Gradle

```bash
./gradlew test jacocoTestReport
```

Default report location:
```
build/reports/jacoco/test/jacocoTestReport.xml
```

### Parsing JaCoCo XML

```xml
<report name="...">
  <package name="com/example/payment">
    <class name="com/example/payment/PaymentService">
      <counter type="BRANCH" missed="4" covered="16"/>
      <counter type="LINE"   missed="2" covered="48"/>
    </class>
  </package>
</report>
```

Per-class branch coverage = `covered / (covered + missed)` from the `BRANCH` counter.
Ignore packages / classes under `target/` or `build/`.

---

## PIT — Mutation Testing

PIT is slow. Warn the user and offer to scope it to a subset of packages.

### Maven

```bash
./mvnw org.pitest:pitest-maven:mutationCoverage \
  -DtargetClasses=com.example.payment.* \
  -DtargetTests=com.example.payment.*Test \
  -DoutputFormats=XML,HTML \
  -DtimestampedReports=false
```

Report location:
```
target/pit-reports/mutations.xml
target/pit-reports/index.html
```

### Gradle

Requires the `info.solidsoft.pitest` plugin. If absent, fall back per Mode
enforcement.

```bash
./gradlew pitest
```

Report location:
```
build/reports/pitest/mutations.xml
```

### Parsing PIT XML

```xml
<mutations>
  <mutation detected="true" status="KILLED" ...>
    <sourceFile>PaymentService.java</sourceFile>
    <mutatedClass>com.example.payment.PaymentService</mutatedClass>
    <mutatedMethod>charge</mutatedMethod>
    <killingTest>com.example.payment.PaymentServiceTest.charge_validCard_returnsTxnId</killingTest>
  </mutation>
  <mutation detected="false" status="SURVIVED" ...>
    ...
  </mutation>
</mutations>
```

**Mutation score per class** = `killed / (killed + survived)`.
- Statuses to count as killed: `KILLED`, `TIMED_OUT`, `MEMORY_ERROR`
- Statuses to count as survived: `SURVIVED`, `NO_COVERAGE`
- Ignore `RUN_ERROR` in the denominator

---

## Execution safeguards

- **Timeout each tool run to 30 minutes.** Kill on exceed and record partial result + caveat.
- **Capture stderr on failure** and include a one-line summary in `meta.environment_probe.tools_attempted_but_failed`
- **Do not run tools in parallel with the AI evaluation phase.** CPU contention makes both unreliable.
- **Disk cleanup:** don't delete build artifacts; the user may want to inspect HTML reports.

---

## Flaky-rate signal

No standard tool — this comes from CI logs, which are environment-specific.

If the user provides a path to CI log output (JSON or JUnit XML surefire
reports from recent builds), parse those. Otherwise, leave `flaky_rate_30d`
as `null` (per the signals contract in output-schema.md).

Expected shape of a surefire-report directory:
```
ci-logs/
  run-1/surefire-reports/TEST-com.example.FooTest.xml
  run-2/surefire-reports/TEST-com.example.FooTest.xml
  ...
```

Flaky rate for a test = fraction of runs where it transitioned between
pass/fail states without a code change between runs.
