# TrustModel Review Action

[![GitHub Marketplace](https://img.shields.io/badge/GitHub%20Marketplace-Trust%20Review%20Action-blue?logo=github)](https://github.com/marketplace/actions/trustmodel-review)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/github/v/release/pdxlab/trustmodel-review-action)](https://github.com/pdxlab/trustmodel-review-action/releases)

> The AI trust gate for your CI/CD — a 10-dimension TrustScore review on every PR that touches AI.
>
> **[→ View on GitHub Marketplace](https://github.com/marketplace/actions/trustmodel-review)**

Add two lines to your GitHub Actions workflow and every PR that changes a prompt, model config, or agent code gets a **TrustScore review comment** and a **required status check** that can block merge if trust regresses.

```yaml
- uses: pdxlab/trustmodel-review-action@v1
  with:
    api_key: ${{ secrets.TRUSTMODEL_API_KEY }}
```

That's it. TrustModel detects AI-related file changes, scores them across 10 dimensions, and posts a diff.

---

## What it does

On every PR that touches AI-related files (prompts, model configs, eval outputs, agent code):

1. **Detects AI changes** — git-diffs the PR and matches against configurable patterns.
2. **Runs a TrustModel eval** — full 10-dimension multi-judge eval, or a free preliminary scan if no API key.
3. **Posts a PR review comment** — TrustScore before/after, per-dimension diff, compliance gaps, link to the full report.
4. **Sets a required status check** (`trustmodel/trust-score`) — passes or blocks merge based on your threshold.

```
## 🔵 TrustModel Review — TrustScore 78/100 (B)  ↓ from 82

| Dimension         | Before | After | Change  |
|---|---|---|---|
| ⭐ Safety         | 85     | 82    | ↓ -3    |
| ⭐ Fairness       | 80     | 71    | ⚠️ -9   |
| Privacy           | 90     | 88    | ↓ -2    |
| Accuracy          | 75     | 78    | ↑ +3    |
...

⚠️ Fairness dropped sharply. Review before merging.

📊 Full report →  🏅 AgentCert →  🔍 TrustModel console →
```

---

## Quick start

### 1 — Add the workflow

```yaml
# .github/workflows/trust-review.yml
name: TrustModel Review
on: [pull_request]
jobs:
  trust-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # needed for git diff
      - uses: pdxlab/trustmodel-review-action@v1
        with:
          api_key: ${{ secrets.TRUSTMODEL_API_KEY }}
          threshold: 70
          framework: NIST_AI_RMF   # optional
          block_on_regression: true
```

### 2 — Add your API key

Settings → Secrets and variables → Actions → New repository secret → `TRUSTMODEL_API_KEY`.

Get a key at [app.trustmodel.ai](https://app.trustmodel.ai) (free tier available — no key needed for a preliminary scan).

### 3 — Make it a required check

Settings → Branches → Branch protection → Require status checks → add `trustmodel/trust-score`.

### 4 — Enable GitHub Code Scanning (optional)

The action emits a **SARIF 2.1.0** file (`tr-results.sarif`) that you can upload to [GitHub Code Scanning](https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning). This surfaces TrustModel findings directly in the **Security** tab alongside your other SAST tools.

Add `permissions: security-events: write` and an upload step:

```yaml
# .github/workflows/trust-review.yml
name: TrustModel Review
on: [pull_request]
permissions:
  contents: read
  pull-requests: write
  security-events: write   # required for Code Scanning upload

jobs:
  trust-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - name: TrustModel Review
        id: tr
        uses: pdxlab/trustmodel-review-action@v1
        with:
          api_key: ${{ secrets.TRUSTMODEL_API_KEY }}
          sarif: 'true'   # default; set to 'false' to skip

      # Upload SARIF to GitHub Code Scanning
      - name: Upload SARIF to Code Scanning
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: ${{ steps.tr.outputs.sarif_path }}
          category: trustmodel-trust-review
```

**What appears in Code Scanning:**

| TR finding | SARIF level | Code Scanning alert severity |
|---|---|---|
| Critical dimension drop >10 pts (enforce mode) | `error` | Critical / High |
| Any regression (warning) | `warning` | Medium |
| Informational (no baseline, compliance gap) | `note` | Low |

Findings are attached to the first AI-related file changed in the PR. All rules link to [trustmodel.ai/agentcert#dimensions](https://trustmodel.ai/agentcert#dimensions).

---

## Configuration

### Action inputs

| Input | Default | Description |
|---|---|---|
| `api_key` | _(none)_ | TrustModel API key (`tm-...`). Blank = free preliminary scan. |
| `threshold` | `65` | Minimum TrustScore to pass the gate (0–100). |
| `framework` | _(none)_ | Compliance framework: `NIST_AI_RMF`, `EU_AI_ACT`, `ISO_42001`, `EEOC`, `HIPAA`, etc. |
| `block_on_regression` | `true` | Fail if a **critical dimension** (Safety/Fairness/Privacy/Compliance) drops >10 points vs base. |
| `cert_on_pass` | `false` | Auto-issue/renew an AgentCert when the check passes. |
| `detect` | _(see below)_ | Comma-separated glob patterns for AI files. Defaults to built-ins or `.trustmodel.yml`. |
| `base_url` | `https://api.trustmodel.ai` | Override for self-hosted TrustModel. |
| `sarif` | `true` | Write a SARIF 2.1.0 file and upload as a workflow artifact. Set to `false` to disable. |

### `.trustmodel.yml` (optional, in repo root)

```yaml
detect:
  - "prompts/**"
  - "agents/**"
  - "**/*.prompt"
eval:
  threshold: 75
  framework: NIST_AI_RMF
  block_on_regression: true
  cert_on_pass: true
```

Action inputs override `.trustmodel.yml` where both are set.

### Default AI-file patterns (applied when `detect` is empty)

```
**/*.prompt, **/*.prompt.txt, **/*.jinja, **/*.jinja2,
**/prompts/**, **/system_prompt*, **/model_config*,
**/llm_config*, **/ai_config*, **/evals/**, **/agents/**,
**/*agent*.py, **/*agent*.ts, **/*agent*.js,
**/chains/**, .trustmodel.yml
```

PRs that don't touch any of these → action skips silently (no comment, green check).

---

## Free vs paid

| | Free (no API key) | Paid (API key) |
|---|---|---|
| Preliminary TrustScore | ✅ | ✅ |
| 10-dimension eval | — | ✅ |
| Multi-judge consensus | — | ✅ |
| Compliance framework mapping | — | ✅ |
| Before/after diff | — | ✅ |
| AgentCert on pass | — | ✅ |
| Audit retention | — | ✅ |

[Get an API key →](https://app.trustmodel.ai)

---

## Roadmap

- [ ] GitHub App (zero-YAML install — no secrets, no workflow file)
- [ ] `npx @trustmodel/cli init` scaffolder
- [x] SARIF output for GitHub Code Scanning integration
- [ ] AgentCert auto-issuance on pass
- [ ] Self-hosted TrustModel support

---

## License

MIT © [Predixtions Inc.](https://trustmodel.ai)
