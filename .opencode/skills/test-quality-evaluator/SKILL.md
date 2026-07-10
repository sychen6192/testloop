---
name: test-quality-evaluator
description: Evaluate the quality of Java unit tests in a repository using a six-dimension Rubric (Effectiveness, Coverage, Independence, Readability, Fast & Reliable, Mock Appropriateness). Trigger this skill whenever the user wants to score, audit, benchmark, or produce a quality report for Java tests — including phrases like "評估 test quality", "score my tests", "跑一下 test 品質報告", "幫我看這個 repo 的測試寫得好不好", "unit test POC", "test quality rubric", or whenever a repo's test folder is provided for batch review. Handles batch evaluation of an entire src/test/java tree, cross-references the corresponding production code, and outputs structured JSON plus a deterministically-rendered Markdown report.
---

# Test Quality Evaluator (Java) — v1.0

A skill for evaluating Java unit test quality against the team's internal Rubric.
Designed for **batch evaluation of an entire repo's test folder**, with strict
guarantees on honesty, determinism, and reproducibility.

---

# PART 1 — IDENTITY

## 1.1 What this skill does

Scores Java unit tests on six quality dimensions and produces:

1. **`test-quality-report.json`** — structured data (machine-readable)
2. **`test-quality-summary.md`** — human-readable report (template-rendered, format-stable)

## 1.2 When to use

Use this skill when the user wants to:

- Score, audit, benchmark, or grade unit tests
- Get a quality report for a Java repo or `src/test/java` subtree
- Compare two repos (Polar Sampling POC)
- Establish a baseline before a refactoring effort

Do **NOT** use this skill for:

- Integration tests, UI tests, performance tests (out of rubric scope)
- Non-Java codebases
- Writing or refactoring tests (this skill is read-only)

## 1.3 Inputs

The skill expects six inputs. Confirm with the user (or infer from context)
before starting:

| Input | Values |
|-------|--------|
| `repo_path` | Path to repo or `src/test/java` subtree |
| `production_code_path` | Path to `src/main/java` (required for accuracy) |
| `metric_mode` | `full` / `provided` / `qualitative-only` |
| `output_mode` | `fast` / `full` |
| `scope` | whole repo / module path / sample size |
| `output_dir` | Where to write JSON and Markdown |

If any are unclear, ask once. Do not ask per-file.

---

# PART 2 — PRINCIPLES

These seven principles are the foundation of the skill. Every workflow phase
and every contract derives from them. When in doubt, return to these.

## P1. Determinism over expressiveness

Tasks that can be done deterministically MUST NOT be delegated to an LLM.
LLM creativity in deterministic tasks is hallucination, not value.

Deterministic tasks include: counting test methods, computing weighted scores,
deriving grade letters, sorting Top-N lists, rendering Markdown reports.

## P2. Honesty over helpfulness

When a measurement is unavailable, the answer is `null` — not a plausible guess.
Sub-agents may be tempted to "fill in" missing values to seem competent.
This is hallucination and is prohibited.

Specifically: `mutation_score`, `branch_coverage`, `flaky_rate_30d`, and
`p95_exec_ms` MUST be `null` unless the corresponding tool was actually
executed and parsed.

## P3. LLM only where judgment is required

Use LLM for: scoring six dimensions, identifying test smells, generating
issue descriptions, suggesting missing test cases.

Do NOT use LLM for: counting, sorting, averaging, grading, parsing config
files, rendering reports, deciding modes.

## P4. Sub-agent isolation

Each sub-agent invocation is independent and stateless. No shared state,
no cross-file context, no awareness of other sub-agents' outputs or
aggregate statistics. Enforcement details: see Part 5.1.

## P5. User intent is sacred

When the user specifies a mode, the skill MUST honor it or stop and ask.
Silent downgrade makes user-facing parameters meaningless and is prohibited.
If `full` mode is requested but tools are unavailable: STOP, present findings,
offer options, wait for explicit confirmation.

## P6. Read-only

This skill never modifies code, build files, or git state. It evaluates;
it does not refactor.

## P7. Transparency

Every report MUST include `meta.environment_probe` showing which tools were
probed, executed, failed, or skipped — and why. Readers verify this section
before trusting the metrics.

---

# PART 3 — RUBRIC

## 3.1 Condensed rubric (default for sub-agents)

Sub-agents score using this compact table. Only consult the full rubric
(`references/rubric.md`) when encountering a pattern not covered here, or
when distinguishing between adjacent score bands (e.g., 3-4 vs 5-6).

| # | Dimension             | Weight | 9-10                                            | 5-6                                | 0-2                                           |
|---|-----------------------|--------|-------------------------------------------------|------------------------------------|-----------------------------------------------|
| 1 | Effectiveness         | 25%    | Strong assertions on exact values               | Only null/empty checks             | Trivial (`assertTrue(true)`)                  |
| 2 | Coverage              | 20%    | Happy + edge + error paths with boundary values | Happy path only                    | Most logic untested                           |
| 3 | Independence          | 15%    | Fully isolated, any order                       | Shared fixtures without cleanup    | Order-dependent                               |
| 4 | Readability           | 15%    | Clear naming + AAA + no magic numbers           | Generic names                      | Incomprehensible                              |
| 5 | Fast & Reliable       | 15%    | No flaky patterns, injected Clock               | Uses `LocalDateTime.now()` as-is   | `Thread.sleep` + real I/O                     |
| 6 | Mock Appropriateness  | 10%    | Mocks only external I/O                         | Some internal mocks                | Over-mocked, `verify(mock)`-only assertions   |

Each dimension is integer 0-10. Weighted score = Σ(score × weight) × 10.

## 3.2 Grade mapping (deterministic, computed by orchestrator)

```
weighted_score >= 85  → "A"
weighted_score >= 70  → "B"
weighted_score >= 55  → "C"
weighted_score <  55  → "D"
```

LLM does NOT pick the grade — orchestrator computes it from the score per P3.

## 3.3 Expected variance

Even with deterministic settings (see Part 5.1), LLM scoring drifts slightly:

- Per-dimension drift: ≤ 1 point (acceptable)
- Total weighted score drift: ≤ 3 points (acceptable)
- Grade letter drift: 0 (must be stable)

If drift exceeds these thresholds, the determinism self-check (5.1) failed.
Use grades for decisions, not precise scores.

---

# PART 4 — WORKFLOW

Six phases, executed in order. Phases 1, 2, 5, and 6 are deterministic
(no LLM). Phases 3 and 4 use LLMs only where judgment is required (P3).

## Phase 1 — Scope & deterministic counting

1. Confirm the six inputs from Part 1.3.
2. Walk the repo tree:
   - Locate test files under `src/test/java`
   - Detect build system (Maven / Gradle)
   - Detect declared plugins (jacoco-maven-plugin, pitest-maven)
3. Count test methods using **deterministic tools**:
   - Primary: AST parsing (javaparser / tree-sitter)
   - Fallback: `grep -rE "^\s*@(Test|ParameterizedTest|RepeatedTest|TestFactory)(\(|$|\s)"`
   - Cross-check: Maven Surefire test listing
   - LLM-based counting is **prohibited** (P1)
4. Define what counts as one test method:
   - `@Test`, `@ParameterizedTest`, `@RepeatedTest`, `@TestFactory` → 1 each
   - `@Nested` classes → recurse
   - `@Disabled` / `@Ignore` → exclude
   - Helper methods, `@BeforeEach`, etc. → exclude
5. Store `expected_test_count` for Phase 5 sanity check.

## Phase 2 — Environment probe & mode confirmation

This phase implements P5 (User intent is sacred) and P7 (Transparency).

### 2.1 Probe checklist (always run)

Execute and record each result:

| Check | Method |
|-------|--------|
| Shell execution | `echo probe_$(date +%s)` |
| Java available | `java -version` |
| Maven wrapper | `./mvnw --version` (if `./mvnw` exists) |
| Gradle wrapper | `./gradlew --version` (if `./gradlew` exists) |
| JaCoCo plugin declared | parse pom.xml or build.gradle |
| PIT plugin declared | parse pom.xml or build.gradle |
| Basic test compile | `./mvnw test -DskipTests=true` (cheap probe) |

**Critical clarification**: `mvn test` runs unit tests via Surefire (built into
Maven). It does NOT require JaCoCo or PIT. Missing these plugins affects
Dimension 1 / 2 *signals*, not the ability to run tests.

### 2.2 Determinism support check

Determine whether the runtime honors `temperature=0`:

- If yes → record `deterministic_mode_supported: true`
- If no or unknown → record `deterministic_mode_supported: false`,
  warn user that scores may have higher drift than documented

### 2.3 Mode enforcement

| User chose | If probe shows | Action |
|------------|----------------|--------|
| `full` | All tools available | Proceed to Phase 3 |
| `full` | Some tools missing | **STOP**, present options, wait for confirmation |
| `full` | Shell unavailable | **STOP**, instruct user to use `provided` or `qualitative-only` |
| `provided` | Report files exist and parse | Proceed |
| `provided` | Report files missing/malformed | **STOP**, ask user |
| `qualitative-only` | (any) | Proceed (no tool execution required) |

When stopping for `full` mode with missing tools, present this exact format:

```
You requested `full` metric mode. Probe found:

✅ Shell execution: available
✅ Maven wrapper: found, version 3.9.x
✅ mvn test: working (compiled successfully)
❌ JaCoCo plugin: not declared in pom.xml
❌ PIT plugin: not declared in pom.xml

`full` mode requires JaCoCo and PIT for quantitative signals.

Please choose:
(A) I'll add the missing plugins to pom.xml and retry
(B) Switch to `provided` mode — I have existing reports at: [path]
(C) Downgrade to `qualitative-only` (Effectiveness & Coverage signals
    will be `null`; AI uses assertion analysis as proxy for scoring)

Which option?
```

### 2.4 What counts as "trying" full mode

Per P5, the LLM MUST actually attempt tool execution, not infer from file
inspection alone:

- ✅ Attempting `./mvnw test`, `./mvnw jacoco:report`, PIT
- ❌ Reading pom.xml and concluding "JaCoCo missing, can't run"
- ❌ Silently setting `metric_mode: qualitative-only` after skipping execution

Every skipped tool MUST be logged in `tools_skipped` with a reason.

## Phase 3 — Quantitative metrics gathering

Branch on `metric_mode` (already user-confirmed in Phase 2):

**`full`** — Execute tools:
1. Run JaCoCo: `./mvnw test jacoco:report` → parse `target/site/jacoco/jacoco.xml`
2. Run PIT (if confirmed): `./mvnw org.pitest:pitest-maven:mutationCoverage` → parse `target/pit-reports/mutations.xml`
3. Record every command in `meta.environment_probe.tools_actually_executed`
4. If a command fails mid-execution: log to `tools_attempted_but_failed`,
   continue with successful signals. Do NOT silently re-label the mode.

**`provided`** — Read user-supplied report files. Validate format. Stop and
ask if malformed.

**`qualitative-only`** — Skip tool execution. All quantitative signal fields
will be `null` per Part 5.2.

Implementation details: see `references/tools.md`.

## Phase 4 — Parallel AI evaluation

This is where LLM judgment is applied (P3).

### 4.1 Per-file evaluation

For each test file:

1. Read the test file
2. Read the production code under test (resolve `FooServiceTest.java` →
   `FooService.java` in `src/main/java`)
3. Score all six dimensions using the condensed rubric (Part 3.1)
4. Generate `top_issues` and `missing_cases` per output mode:
   - `fast`: max 2 issues, max 3 missing cases, no per-dimension reasoning
   - `full`: max 5 issues, max 5 missing cases, plus reasoning per dimension
5. Combine quantitative signals from Phase 3 (if available) with AI judgment
6. Output ONE JSON record per the contract in Part 5.3

### 4.2 Parallel dispatch

When test file count > 10, dispatch in parallel per Part 5.4 (Concurrency rules)
and Part 5.1 (Sub-agent contract).

### 4.3 Determinism self-check (run once at start)

Before dispatching the full batch, run a self-check per Part 5.1:

1. Pick the first test file
2. Run sub-agent twice with identical input
3. Compare outputs
4. Record result in `meta.environment_probe.determinism_self_check`
5. If failed: warn but continue, ensure final report discloses the failure

### 4.4 Micro-batching

Files with < 10 test methods: batch up to 3 files (same package) per
sub-agent to reduce overhead. Files with ≥ 10 methods: 1 sub-agent per file.
Never batch across packages — SUT context differs.

## Phase 5 — Validation & aggregation (deterministic)

This phase MUST be done by orchestrator code, never LLM (P1, P3).

### 5.1 Schema validation

Validate every sub-agent output against the JSON schema in
`references/output-schema.md`. Validation failure → reject + retry sub-agent.

### 5.2 Signals contract validation

Run the `validate_signals()` check from Part 5.2 (Quantitative signals
contract). Failure → reject + retry with stricter prompt.

### 5.3 Sanity check

Verify: `expected_test_count == actual_evaluated_count == len(report.tests)`

Mismatch → log missing tests by name to `meta.errors`, do NOT silently
omit them from the report.

### 5.4 Aggregation (pure math)

Compute deterministically (no LLM):
- `summary.grade_distribution` (count by grade)
- `summary.avg_weighted_score` (arithmetic mean)
- `summary.dimension_averages` (per-dimension mean)
- `summary.top_smells` (count + sort)
- Top 10 lowest-scoring tests (sort + slice)

## Phase 6 — Render & present (deterministic)

This phase MUST be done by orchestrator code (P1, P3). The LLM has no role here.

### 6.1 Render JSON

- Pretty-print with stable key ordering
- Write `test-quality-report.json` to `output_dir`
- For the same input data, byte-identical output (modulo timestamps and
  LLM-generated text fields like reasoning/descriptions)

### 6.2 Render Markdown via template

- Load `references/report-template.md.tmpl`
- Substitute variables from validated JSON
- Write `test-quality-summary.md` to `output_dir`
- Format MUST be byte-stable for the same JSON input

### 6.3 What stays stable, what varies

For the same input repo:

**Stable (byte-identical)**:
- Section order
- Table columns
- Section headers
- Disclaimer text
- Caveats wording
- Emoji usage

**Varying (and that's OK)**:
- Per-test reasoning text (LLM-generated)
- Per-issue descriptions (LLM-generated)
- Specific score values (±3 drift expected)

### 6.4 Anti-patterns (prohibited)

❌ "Generate a Markdown summary of these results"
❌ "Write a nice executive summary"
❌ "Format this nicely"

✅ Pure template substitution

### 6.5 Present

After rendering:
1. Show grade distribution and Top-5 issues inline
2. Link to JSON and Markdown files
3. Note any caveats from `meta.errors` or `meta.caveats`

---

# PART 5 — CONTRACTS

## 5.1 Sub-agent contract

### Required runtime parameters

The orchestrator MUST send these with every sub-agent call:

```json
{
  "temperature": 0,
  "top_p": 1.0,
  "seed": 42
}
```

If the runtime does not support `temperature` (some self-hosted deployments),
log this in `meta.environment_probe.deterministic_mode_supported = false`
and disclose in the final report.

### Determinism self-check

Once per evaluation run, before processing the full batch:

1. Pick the first test file
2. Run sub-agent twice with identical input (same prompt, same files, same
   parameters)
3. Compare the two outputs:
   - Per-dimension score difference
   - Total weighted score difference
4. Record the result:

```json
"determinism_self_check": {
  "performed": true,
  "passed": <bool>,           // true if drift within thresholds
  "max_dimension_drift": <int>,
  "max_total_drift": <float>,
  "thresholds": {
    "max_dimension_drift": 1,
    "max_total_drift": 3.0
  }
}
```

If `passed: false`, the report MUST include this caveat:

> ⚠️ Determinism self-check failed. Score drift exceeds expected thresholds.
> Scores in this report may not be reproducible across runs. Use grade
> letters for decisions, not precise scores.

### Isolation requirements

- Each sub-agent receives ONE test file (or one micro-batch) + matched
  production code + condensed rubric
- No shared state with other sub-agents
- No awareness of aggregate statistics
- No prior sub-agent outputs in context
- Idempotent: same input produces same output structure

### Retry strategy

On invalid output (failed JSON parse or schema validation), retry up to 2x
with progressively simpler prompts:

1. **Attempt 1**: full condensed rubric + 6 dims + issues + missing_cases
2. **Attempt 2**: condensed rubric + 6 dims only (drop issues + missing_cases)
3. **Attempt 3**: 6 scores only, no justifications

After 3 failures: emit `{"status": "error", "file": "...", "reason": "..."}`
and continue. Never fabricate output.

## 5.2 Quantitative signals contract

This contract implements P2 (Honesty over helpfulness).

### Strict null rules

| Field | MUST be null when |
|-------|-------------------|
| `mutation_score` | PIT XML was not parsed (regardless of mode) |
| `branch_coverage` | JaCoCo XML was not parsed |
| `flaky_rate_30d` | CI log directory was not parsed |
| `p95_exec_ms` | CI log directory was not parsed |
| `mock_count` | AST analysis was not performed |

### Orchestrator-side validation

After all sub-agents return, the orchestrator runs:

```
for each test in report.tests:
  signals = test.signals or {}

  if "pit" not in environment_probe.tools_actually_executed:
    require: signals.mutation_score is null
    on violation: reject + retry sub-agent with stricter prompt

  if "jacoco" not in environment_probe.tools_actually_executed:
    require: signals.branch_coverage is null
    on violation: reject + retry

  (same logic for flaky_rate_30d and p95_exec_ms)
```

### Sub-agent prompt clause (mandatory)

Every sub-agent prompt MUST include:

> CRITICAL: The `signals` block contains quantitative measurements that
> require external tool execution. If you do not see actual tool output
> data in the input I gave you, set ALL signal fields to `null`. Do NOT
> estimate, infer, guess, or "fill in plausible values" for missing
> signals. Inferring is hallucination and will cause your output to be
> rejected.

## 5.3 Output schema contract

Full JSON schema with `fast` vs `full` mode differences: see
`references/output-schema.md`.

Core invariants:
- Per-test record always has `scores` (six integers 0-10)
- `weighted_score` and `grade` are computed by orchestrator, not LLM
- `signals` follows the contract in 5.2
- `meta.environment_probe` is mandatory in every report

## 5.4 Concurrency rules

- Default concurrency: **8**
- Scale down to 5 if error rate exceeds 5% or rate limits hit
- Scale down to 3 if model server shows queuing (latency variance > 2x)
- On rate limit / 429: exponential backoff, do NOT increase concurrency
- Determinism self-check runs sequentially (concurrency = 1)

---

# PART 6 — REFERENCE FILES

Consult these as needed. Do not inline their full contents into responses.

| File | Purpose | When to read |
|------|---------|--------------|
| `references/rubric.md` | Full 6-dim rubric with detailed Java examples | Only when condensed rubric (Part 3.1) is insufficient |
| `references/output-schema.md` | Detailed JSON schema, field rules | When implementing or debugging output |
| `references/tools.md` | JaCoCo, PIT, counting commands | During Phase 1 / 3 |
| `references/report-template.md.tmpl` | Markdown template (variable substitution only) | Phase 6 only |
| `references/polar-sampling.md` | Good-vs-bad repo comparison format | When evaluating two repos |
| `references/stability-check.md` | Variance test procedure | After major skill / runtime changes |

---

# PART 7 — KNOWN LIMITATIONS

- **Rubric weights** (25/20/15/15/15/10) are team assumptions, not industry
  standard. Will be calibrated via the Evaluation Set (Task 6).
- **AI scoring** of Readability and Mock Appropriateness has subjectivity.
  Target agreement with senior engineers: ≥ 80%, not 100%.
- **Score drift**: even with `temperature=0`, total score variance is
  typically ±3 points across runs. Use grades for decisions.
- **PIT** is slow on large codebases. `qualitative-only` is the pragmatic
  default for first-pass POC.
- **JUnit 4** projects: rubric concepts apply, but example annotations differ.
  Note JUnit version in the report.
- **Self-hosted runtimes**: if `temperature` is not honored, drift will be
  larger and the determinism self-check will warn accordingly.

---

# PART 8 — CHANGELOG

## v1.0 (current) — Major restructure

**Architecture**:
- Reorganized into 8 Parts: Identity / Principles / Rubric / Workflow /
  Contracts / References / Limitations / Changelog
- Extracted seven core principles (P1-P7) from previously scattered rules
- Removed redundant "Critical rules" section (rules now live in Principles
  + Contracts, no duplication)

**Three issues resolved from v0.3 demo feedback**:

1. **Mutation score fabrication (Issue: signals reported without running PIT)**
   - Added Part 5.2 Quantitative signals contract
   - Strict null rules for `mutation_score`, `branch_coverage`, etc.
   - Orchestrator-side validation that rejects fabricated values
   - Mandatory prompt clause forbidding inference of missing signals

2. **Report format inconsistency (Issue: Markdown different every run)**
   - Added Phase 6 (Render & Present) — fully deterministic
   - Markdown rendered from `references/report-template.md.tmpl` via
     variable substitution, NOT LLM
   - Format byte-stable for same input data

3. **Temperature / determinism uncertainty**
   - Added explicit runtime parameters in Part 5.1 (temperature=0, top_p=1.0, seed)
   - Added determinism self-check (run once per evaluation)
   - Added `deterministic_mode_supported` and `determinism_self_check` to
     environment_probe disclosure
   - Final report warns when self-check fails

**Other**:
- Six phases (was 5), with Render explicitly separated from Aggregation
- Concurrency default: 8 (unchanged)
- Output mode: `fast` / `full` (unchanged)

## v0.3 — Honesty patches
- Phase 1.5 environment probe
- Mode enforcement (no silent downgrade)
- Clarified `mvn test` vs plugin requirements

## v0.2 — Determinism baseline
- Determinism requirements section
- Test method counting rules
- Phase 4 sanity check
- Condensed rubric in SKILL.md
- Output modes (`fast` / `full`)
- Concurrency 3 → 8
- Micro-batching

## v0.1 — Initial
- 6-dimension rubric
- Parallel evaluation
- Polar sampling support
