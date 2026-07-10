# Stability Check Guide — v1.0

Use this reference when validating that the runtime configuration produces
stable, reproducible scores. Two related but distinct mechanisms exist:

1. **Determinism self-check** — automated, runs once per evaluation
   (defined in SKILL.md Part 5.1)
2. **Manual stability check** — multi-run validation, run when onboarding
   a new model server or making major skill changes

This document covers both.

---

## 1. Automated determinism self-check

This runs automatically at the start of every evaluation when test count > 1.
You don't need to invoke it manually — the orchestrator does it.

### What it does

1. Picks the first test file in scope
2. Runs the sub-agent on it twice with **identical input**
   (same prompt, same files, same parameters)
3. Compares the two outputs:
   - Per-dimension score difference
   - Total weighted score difference
4. Records the result in `meta.environment_probe.determinism_self_check`

### Pass / fail thresholds

```
PASS criteria:
  max_dimension_drift <= 1
  max_total_drift <= 3.0

FAIL criteria:
  max_dimension_drift > 1
  OR max_total_drift > 3.0
```

### Why this matters

A skill that claims `temperature=0` semantics but produces drift > 3 points
is misleading users. The self-check catches this within 30 seconds, so
users can't be tricked into trusting unstable scores.

### What to do if self-check fails

If failed:
1. The skill continues (does not abort)
2. The final report includes a prominent warning
3. Investigate the cause:
   - Is `temperature=0` actually being passed to the LLM API?
   - Is the runtime honoring the parameter?
   - Is there context bleeding between sub-agent calls?

Common root causes:
- Self-hosted model server ignores `temperature` parameter
- API gateway strips/overrides the parameter
- Orchestrator forgets to pass parameters
- Sub-agents share context (P4 violation)

---

## 2. Manual stability check (occasional)

Run this when:

- Onboarding a new model server or runtime
- After major skill version changes (e.g., v0.x → v1.0)
- When users report unexpected score drift
- Before relying on the skill for high-stakes decisions

### Setup

Pick **5 test files** spanning quality:

- 2 expected high-quality (recently refactored)
- 2 expected low-quality (known test debt)
- 1 medium

Don't pick random files — you need to verify the rubric distinguishes
known good from known bad.

### Procedure

```
1. Run skill once with:
   - output_mode: fast
   - metric_mode: qualitative-only
   - concurrency: 1 (eliminate parallelism as variable)
   Save output as run-1.json

2. Wait 5+ minutes

3. Run skill again with identical settings.
   Save as run-2.json

4. (Optional) Run a third time for median computation.
   Save as run-3.json
```

### Analysis

#### Check A — Absolute score drift

For each file, compute `|run_1.weighted_score - run_2.weighted_score|`:

| Drift (points) | Interpretation | Action |
|----------------|----------------|--------|
| 0-2 | Normal | Trust the skill |
| 3-5 | Borderline high | Use median of 3 runs for high-stakes decisions |
| 6-10 | Suspicious | Check temperature setting, sub-agent isolation |
| > 10 | Broken | Halt — something is fundamentally wrong |

#### Check B — Per-dimension variance

Tabulate dimension scores across runs:

```
              run_1  run_2  diff
effectiveness   8      7    -1
coverage        7      8    +1
independence   10     10     0   ← stable
readability     6      8    +2   ← unstable
fast_reliable   9      9     0
mock_smells     5      6    +1
```

Dimensions with drift > 1 consistently indicate:
- Condensed rubric band definitions are too fuzzy for that dimension
- LLM interprets that dimension inconsistently

**Fix**: expand that dimension's section in `references/rubric.md` with
more concrete examples, then re-run the stability check.

#### Check C — Ranking stability (most important)

Sort files by `weighted_score`:

```
Run 1: D < E < B < A < C
Run 2: D < B < E < A < C
```

If rankings are **identical or near-identical** (especially for extremes):
- ✅ Skill reliably distinguishes good from bad
- ✅ Even with absolute drift, the tool is useful for "find Top N worst"
- ✅ Grade distribution should be very similar

If rankings flip (bad tests beating good tests):
- ❌ Skill is not yet trustworthy
- ❌ Do NOT use for any reporting; investigate and fix first

---

## 3. Interpreting self-check vs manual check

| Self-check result | Manual check needed? |
|-------------------|----------------------|
| Passed | Optional — only if other concerns arise |
| Failed | **Yes — diagnose root cause** |
| Could not run | **Yes — runtime may not support it** |

The self-check is fast and automated. The manual check is thorough but
expensive (5+ files × multiple runs). They complement each other.

---

## 4. Common failure patterns and fixes

### Pattern: Large drift on one specific dimension

**Likely cause**: That dimension's rubric bands are ambiguous; LLM picks
a band based on subtle prompt context that varies.

**Fix**: Add more concrete band examples to `references/rubric.md` for
that dimension. Re-run.

### Pattern: All scores drift uniformly by ±2-3 points

**Likely cause**: `temperature=0` is not actually applied. Runtime may
silently default to higher temperature.

**Fix**:
1. Check `meta.environment_probe.deterministic_mode_supported`
2. If `false`, contact infra to verify temperature support
3. If `true` but still drifting, check orchestrator code passes the
   parameter on every call

### Pattern: Test count differs between runs

**Likely cause**: LLM-based counting (P1 violation) or some sub-agents
silently failing.

**Fix**:
1. Verify Phase 1 uses deterministic counting (grep/AST/Surefire)
2. Check `meta.errors` for sub-agent failures
3. Run sanity check (Phase 5.3) and audit `meta.errors`

### Pattern: Rankings flip

**Likely cause**: Sub-agent isolation broken (P4 violation). Orchestrator
may be passing earlier results as context to later sub-agents.

**Fix**: Audit orchestrator code — every sub-agent must receive identical
prompt structure with no cross-file context.

---

## 5. Reporting stability

In formal reports, disclose stability data in `meta.caveats`:

```json
"caveats": [
  "Determinism self-check: passed (max drift 0.8 points)",
  "Manual stability check (2026-04-29): rankings 100% consistent across 3 runs",
  "Per-dimension variance: highest in Readability (±1.2)"
]
```

Hiding variance and claiming deterministic scores is worse than openly
stating known limits. Honest disclosure builds trust.

---

## 6. When to re-run

| Trigger | Action |
|---------|--------|
| SKILL.md Phase 3-6 changed | Manual check |
| Condensed rubric changed | Manual check |
| Model version / serving infra changed | Manual check |
| Routine code/doc tweaks | Self-check is enough |
| Quarterly cadence | Manual check (good hygiene) |

Do NOT re-run after every minor change — too expensive. Self-check covers
day-to-day; manual check is for major events.
