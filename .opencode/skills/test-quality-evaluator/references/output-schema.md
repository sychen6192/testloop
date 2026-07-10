# Output Schema — v1.0

The skill produces two files:

1. `test-quality-report.json` — structured, for downstream tooling
2. `test-quality-summary.md` — human-readable, template-rendered (Phase 6)

This document defines the JSON schema and validation rules. The orchestrator
MUST validate every sub-agent output against this schema (Phase 5.1).

---

## Per-test record

### `full` mode (complete)

```json
{
  "file": "src/test/java/com/example/payment/PaymentServiceTest.java",
  "test_class": "com.example.payment.PaymentServiceTest",
  "test_method": "processPayment_withInvalidCard_throwsException",
  "line": 42,
  "sut": "com.example.payment.PaymentService",
  "scores": {
    "effectiveness": 8,
    "coverage": 7,
    "independence": 10,
    "readability": 9,
    "fast_reliable": 10,
    "mock_appropriateness": 6
  },
  "reasoning": {
    "effectiveness": "Strong assertion on exception type and message",
    "coverage": "Error path covered, but expired-card edge case missing",
    "independence": "Fully isolated, no shared state",
    "readability": "Clear method name, AAA structure present",
    "fast_reliable": "No timing or I/O dependencies",
    "mock_appropriateness": "PaymentValidator mocked unnecessarily"
  },
  "weighted_score": 82.0,
  "grade": "B",
  "signals": {
    "mutation_score": 0.75,
    "branch_coverage": 0.82,
    "flaky_rate_30d": null,
    "p95_exec_ms": null,
    "mock_count": 6
  },
  "top_issues": [
    {
      "dimension": "mock_appropriateness",
      "severity": "medium",
      "description": "PaymentValidator is mocked despite being internal pure logic; use a real instance",
      "line": 23,
      "reference": "Meszaros Test Smell: Excessive Setup"
    }
  ],
  "missing_cases": [
    "expired card",
    "insufficient funds",
    "card country mismatch"
  ]
}
```

### `fast` mode (minimal)

```json
{
  "file": "src/test/java/com/example/payment/PaymentServiceTest.java",
  "test_class": "com.example.payment.PaymentServiceTest",
  "test_method": "processPayment_withInvalidCard_throwsException",
  "line": 42,
  "sut": "com.example.payment.PaymentService",
  "scores": {
    "effectiveness": 8,
    "coverage": 7,
    "independence": 10,
    "readability": 9,
    "fast_reliable": 10,
    "mock_appropriateness": 6
  },
  "weighted_score": 82.0,
  "grade": "B",
  "signals": {
    "mutation_score": null,
    "branch_coverage": null,
    "flaky_rate_30d": null,
    "p95_exec_ms": null,
    "mock_count": 6
  },
  "top_issues": [
    {
      "dimension": "mock_appropriateness",
      "severity": "medium",
      "line": 23,
      "description": "Excessive mocking of internal classes"
    }
  ],
  "missing_cases": ["expired card", "insufficient funds"]
}
```

### Mode differences

| Field            | `fast`                      | `full`                     |
|------------------|-----------------------------|----------------------------|
| `scores`         | Required                    | Required                   |
| `weighted_score` | Required (orchestrator-set) | Required (orchestrator-set)|
| `grade`          | Required (orchestrator-set) | Required (orchestrator-set)|
| `reasoning`      | Omitted                     | Required (1 sentence each) |
| `top_issues`     | Max 2, no `reference`       | Max 5, full fields         |
| `missing_cases`  | Max 3 strings               | Max 5 strings              |
| `signals.*`      | Per signals contract        | Per signals contract       |

---

## Critical: Quantitative signals contract

This section enforces P2 (Honesty over helpfulness) from SKILL.md.
**Violations of these rules MUST cause the orchestrator to reject the
sub-agent output and retry.**

### Strict null rules

| Field              | MUST be `null` when                                 |
|--------------------|-----------------------------------------------------|
| `mutation_score`   | PIT XML was not parsed (regardless of mode)         |
| `branch_coverage`  | JaCoCo XML was not parsed                           |
| `flaky_rate_30d`   | CI log directory was not parsed                     |
| `p95_exec_ms`      | CI log directory was not parsed                     |
| `mock_count`       | Acceptable to populate via AST analysis (deterministic) |

### Orchestrator validation pseudocode

```python
def validate_signals(report, environment_probe):
    executed = environment_probe["tools_actually_executed"]
    pit_ran = any("pit" in cmd.lower() for cmd in executed)
    jacoco_ran = any("jacoco" in cmd.lower() for cmd in executed)
    ci_logs_parsed = any("surefire" in cmd.lower() or "ci-log" in cmd.lower() for cmd in executed)

    for test in report["tests"]:
        signals = test.get("signals") or {}

        if not pit_ran and signals.get("mutation_score") is not None:
            raise ValidationError(
                f"{test['file']}: mutation_score must be null "
                f"(PIT was not executed). Got: {signals['mutation_score']}"
            )

        if not jacoco_ran and signals.get("branch_coverage") is not None:
            raise ValidationError(
                f"{test['file']}: branch_coverage must be null "
                f"(JaCoCo was not executed). Got: {signals['branch_coverage']}"
            )

        if not ci_logs_parsed:
            for f in ["flaky_rate_30d", "p95_exec_ms"]:
                if signals.get(f) is not None:
                    raise ValidationError(
                        f"{test['file']}: {f} must be null (CI logs not parsed)"
                    )
```

### On validation failure

1. Reject the report (do not write to disk)
2. Log to `meta.errors`
3. Re-prompt the violating sub-agent with a stricter instruction:
   ```
   REMINDER (your previous output was rejected): the signals.{field} 
   field MUST be null because {tool} was not executed. Do not estimate, 
   infer, or "fill in" a plausible value. Set it to null.
   ```
4. After 3 rejections: emit `{"status": "error"}` for that file.

### Mandatory sub-agent prompt clause

Every sub-agent prompt MUST include the exact text:

> **CRITICAL**: The `signals` block contains quantitative measurements
> that require external tool execution. If you do not see actual tool
> output data (PIT XML, JaCoCo XML, CI logs) in the input I gave you,
> set ALL relevant signal fields to `null`. Do NOT estimate, infer,
> guess, or fill in plausible values. Inferring is hallucination and
> will cause your output to be rejected.

---

## Field-level rules

### `scores.*`

- Type: integer
- Range: 0-10 inclusive
- Required: yes (all six dimensions)
- Source: LLM judgment

### `weighted_score`

- Type: float
- Formula: `(0.25*effectiveness + 0.20*coverage + 0.15*independence + 0.15*readability + 0.15*fast_reliable + 0.10*mock_appropriateness) * 10`
- Computed by: orchestrator, NOT LLM
- Why: deterministic arithmetic should not have LLM variance (P1, P3)

### `grade`

- Type: string `"A" | "B" | "C" | "D"`
- Mapping:
  ```
  weighted_score >= 85  → "A"
  weighted_score >= 70  → "B"
  weighted_score >= 55  → "C"
  weighted_score <  55  → "D"
  ```
- Computed by: orchestrator, NOT LLM

### `top_issues[].severity`

- Type: string `"low" | "medium" | "high"`
- Definition:
  - `high`: likely production risk or false-negative test (test passes when it shouldn't)
  - `medium`: real smell worth fixing
  - `low`: style nit

### `missing_cases`

- Type: array of strings
- Format: human-readable scenario names (e.g., "expired card"), not code
- Empty array if test is thorough

### `reasoning` (full mode only)

- Type: object with one string per dimension
- Length: one sentence each (≤ 30 words)
- Source: LLM

### `signals` block

- See "Quantitative signals contract" above

---

## Aggregate report (top of JSON)

```json
{
  "meta": {
    "skill_version": "v1.0",
    "rubric_version": "v1.0",
    "generated_at": "2026-04-29T10:00:00Z",
    "repo": "payment-service",
    "scope": "full",
    "output_mode": "fast",
    "metric_mode": "qualitative-only",
    "metric_mode_user_confirmed": true,
    "concurrency": 8,
    "expected_test_count": 221,
    "actual_test_count": 221,
    "sanity_check_passed": true,
    "environment_probe": {
      "shell_available": true,
      "java_version": "17.0.8",
      "maven_wrapper_found": true,
      "gradle_wrapper_found": false,
      "jacoco_plugin_configured": false,
      "pit_plugin_configured": false,
      "basic_test_compile_ok": true,
      "deterministic_mode_supported": true,
      "tools_actually_executed": [
        "mvn test -DskipTests=true"
      ],
      "tools_attempted_but_failed": [],
      "tools_skipped": [
        "mvn jacoco:report (plugin not declared)",
        "mvn pitest:mutationCoverage (plugin not declared)"
      ],
      "determinism_self_check": {
        "performed": true,
        "passed": true,
        "max_dimension_drift": 1,
        "max_total_drift": 2.5,
        "thresholds": {
          "max_dimension_drift": 1,
          "max_total_drift": 3.0
        }
      }
    },
    "caveats": [
      "Rubric v1.0 — weights still being calibrated via Evaluation Set",
      "User confirmed downgrade from `full` to `qualitative-only` (JaCoCo/PIT not available)"
    ],
    "errors": []
  },
  "summary": {
    "grade_distribution": { "A": 34, "B": 112, "C": 76, "D": 26 },
    "avg_weighted_score": 71.3,
    "score_drift_disclaimer": "Scores have ±3 point drift across runs. Use grade buckets for decisions.",
    "dimension_averages": {
      "effectiveness": 7.2,
      "coverage": 7.5,
      "independence": 8.8,
      "readability": 7.0,
      "fast_reliable": 8.4,
      "mock_appropriateness": 6.3
    },
    "top_smells": [
      { "type": "Excessive Setup", "count": 42 },
      { "type": "Assertion Roulette", "count": 28 }
    ],
    "top_10_lowest_scoring": [
      {
        "file": "...",
        "test_method": "...",
        "weighted_score": 32.5,
        "grade": "D",
        "main_issue": "..."
      }
    ]
  },
  "tests": [ /* per-test records */ ]
}
```

### Required meta fields

- `skill_version` — matches the SKILL.md version
- `rubric_version` — version of the rubric in use
- `output_mode` — `"fast"` | `"full"`
- `metric_mode` — `"full"` | `"provided"` | `"qualitative-only"`
- `metric_mode_user_confirmed` — `true` ONLY if user explicitly confirmed.
  Setting this to `true` without confirmation = lying in the report.
- `concurrency` — actual concurrency used
- `expected_test_count` — from Phase 1 deterministic counting
- `actual_test_count` — `len(tests[])` after evaluation
- `sanity_check_passed` — `expected_test_count === actual_test_count`
- `environment_probe` — full probe result, MANDATORY
- `errors[]` — list of failures with details

### environment_probe field details

| Subfield | Type | Required | Meaning |
|----------|------|----------|---------|
| `shell_available` | bool | yes | Whether runtime can execute shell |
| `java_version` | string\|null | yes | `java -version` output, null if N/A |
| `maven_wrapper_found` | bool | yes | `./mvnw` exists & executable |
| `gradle_wrapper_found` | bool | yes | `./gradlew` exists & executable |
| `jacoco_plugin_configured` | bool | yes | Declared in pom.xml/build.gradle |
| `pit_plugin_configured` | bool | yes | Declared in pom.xml/build.gradle |
| `basic_test_compile_ok` | bool | yes | `mvn test -DskipTests=true` worked |
| `deterministic_mode_supported` | bool | yes | Runtime honors `temperature=0` |
| `tools_actually_executed` | string[] | yes | Commands actually run |
| `tools_attempted_but_failed` | object[] | yes | `{command, error}` pairs |
| `tools_skipped` | string[] | yes | Skipped commands with reason |
| `determinism_self_check` | object | yes | Result of Part 5.1 self-check |

### errors array entries

Each entry has `type` and type-specific fields:

```json
// Missing tests
{
  "type": "missing_tests",
  "expected_count": 221,
  "actual_count": 218,
  "missing": ["com.example.FooTest.testBar", "..."]
}

// Sub-agent failures
{
  "type": "sub_agent_failure",
  "file": "src/test/java/...",
  "reason": "Failed to parse JSON after 3 retries",
  "last_error": "Expected `{`, got `H`"
}

// Signals contract violation
{
  "type": "signals_contract_violation",
  "file": "src/test/java/...",
  "field": "mutation_score",
  "got_value": 0.75,
  "expected": "null (PIT was not executed)"
}
```

---

## Schema conventions

- Scores: integers 0-10
- Rates (`mutation_score`, `branch_coverage`, `flaky_rate_30d`): floats 0.0-1.0
- Durations (`p95_exec_ms`): milliseconds, integer
- Timestamps: ISO 8601 UTC
- Paths: repo-relative POSIX style
- All `null` values must be JSON `null`, not `0` or empty string

---

## Don'ts

- Don't add fields not in this schema without noting in `meta.caveats`
- Don't silently drop tests — include with `{"status": "error", "reason": "..."}`
- Don't produce a report when `sanity_check_passed: false` without populating
  `errors`
- Don't let LLM compute `weighted_score` or `grade`
- Don't set `metric_mode_user_confirmed: true` without explicit user confirmation
- Don't omit `environment_probe`
- Don't fill `signals.*` with non-null values without actual tool execution
- Don't emit `"determinism_self_check.performed": true` without actually running it
