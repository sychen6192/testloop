# Polar Sampling Comparison Report — v1.0

When the user runs the skill on **two repos** — one expected to be high-quality
and one expected to be low-quality — produce a side-by-side comparison on top
of the standard per-repo reports.

This is the format for a POC validation: the goal is to show whether the
rubric + AI scoring **successfully distinguishes** good tests from bad tests.
If the two repos end up with similar scores, the rubric (or the AI prompt)
needs calibration.

---

## Required output file

`polar-sampling-comparison.md` — human-readable, one per pair of repos.
Rendered deterministically from JSON, NOT by LLM (per SKILL.md P1).

Also add a `comparison` block at the top of the combined JSON:

```json
{
  "comparison": {
    "repo_a": { "name": "core-billing",     "expected": "high" },
    "repo_b": { "name": "legacy-reporting", "expected": "low" },
    "expected_gap": "repo_a > repo_b",
    "observed_avg_scores": { "repo_a": 78.2, "repo_b": 51.4 },
    "discriminated_correctly": true,
    "dimension_gaps": {
      "effectiveness": 2.1,
      "coverage": 1.8,
      "independence": 0.3,
      "readability": 3.5,
      "fast_reliable": 1.2,
      "mock_appropriateness": 2.8
    }
  }
}
```

`discriminated_correctly` = `true` when the repo labeled "high" has a higher
average than the one labeled "low". If `false`, raise it prominently.

---

## Markdown comparison template

Render this with variable substitution, NOT LLM (per Phase 6 rules):

```markdown
# POC — Polar Sampling Comparison

**Repos compared:**
- 🟢 `{{repo_a}}` (expected: high quality)
- 🔴 `{{repo_b}}` (expected: low quality)

**Generated:** {{generated_at}}
**Skill version:** {{skill_version}}

---

## Headline

{{verdict_sentence}}

| Metric | {{repo_a}} | {{repo_b}} | Gap |
|--------|-----------|-----------|-----|
| Avg weighted score | {{a_avg}} | {{b_avg}} | {{gap_score}} |
| % A-grade tests | {{a_pct_a}}% | {{b_pct_a}}% | {{gap_a_pct}} |
| % D-grade tests | {{a_pct_d}}% | {{b_pct_d}}% | {{gap_d_pct}} |

---

## Per-dimension gap

Larger gap = dimension is doing a good job distinguishing quality.
Near-zero gap = dimension may be insensitive or AI may be struggling.

| Dimension | {{repo_a}} avg | {{repo_b}} avg | Gap | Notes |
|-----------|---------------|---------------|-----|-------|
| Effectiveness | {{a_eff}} | {{b_eff}} | {{gap_eff}} | {{note_eff}} |
| Coverage | {{a_cov}} | {{b_cov}} | {{gap_cov}} | {{note_cov}} |
| Independence | {{a_ind}} | {{b_ind}} | {{gap_ind}} | {{note_ind}} |
| Readability | {{a_read}} | {{b_read}} | {{gap_read}} | {{note_read}} |
| Fast & Reliable | {{a_fast}} | {{b_fast}} | {{gap_fast}} | {{note_fast}} |
| Mock Appropriateness | {{a_mock}} | {{b_mock}} | {{gap_mock}} | {{note_mock}} |

---

## POC conclusion

{{conclusion_block}}

---

## Appendix

- Full report: `{{repo_a}}/test-quality-summary.md`
- Full report: `{{repo_b}}/test-quality-summary.md`
- Raw data: `{{repo_a}}/test-quality-report.json`, `{{repo_b}}/test-quality-report.json`
```

---

## Verdict logic (deterministic, NOT LLM)

The orchestrator computes the verdict using fixed thresholds:

| Avg score gap | Ordering correct? | Verdict |
|---------------|-------------------|---------|
| ≥ 15 points | Yes | "Rubric and AI scoring discriminate good from bad tests as expected. Proceed to wider rollout with Evaluation Set validation." |
| 5-15 points | Yes | "Rubric discriminated, but weaker than expected. Consider reviewing scoring criteria for low-gap dimensions before rollout." |
| < 5 points | Yes | "Scores between the two repos are not meaningfully different. Rubric or prompt needs re-calibration before rollout." |
| any | No | "**FAILED** — Repo expected to be high-quality scored lower than the low-quality repo. Rubric or AI scoring is not working correctly. Investigate before any further use." |

Per-dimension note logic:

```python
if gap < 0.5:
    note = "⚠️ low gap — revisit signals"
elif gap > 3.0:
    note = "largest gap"
else:
    note = ""
```

---

## Why this matters

A failed polar-sampling comparison is a useful finding, not a problem to paper
over. Be honest. The whole point is validation — if the skill can't tell good
from bad on extreme samples, fix it before running on real data.
