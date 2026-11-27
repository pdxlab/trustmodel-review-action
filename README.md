# TrustModel Review (TR) Action

[![GitHub Marketplace](https://img.shields.io/badge/GitHub%20Marketplace-Trust%20Review%20Action-blue?logo=github)](https://github.com/marketplace/actions/trustmodel-review)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/github/v/release/pdxlab/trustmodel-review-action)](https://github.com/pdxlab/trustmodel-review-action/releases)

The missing CI gate for AI code changes. Automatically evaluates every PR that touches prompts, agents, evals, or model config against **10 trust dimensions** — safety, fairness, accuracy, privacy, and more — and blocks the merge if the TrustScore drops below your threshold.

---

## Install in 3 steps

### Step 1 — Install the GitHub App

**[Install TrustModel Review on GitHub](https://github.com/apps/trustmodel-review)**

This grants TR read access to your repo so it can fetch changed AI files for evaluation. Required for private repos. Public repos can skip this step.

> One-click install. Select the repos you want TR to evaluate. No other permissions needed.

### Step 2 — Add your API key

Get a free API key at **[trustmodel.ai/developers](https://trustmodel.ai/developers)**, then add it as a repository secret:

**Settings → Secrets and variables → Actions → New repository secret**

Name: `TRUSTMODEL_API_KEY`

### Step 3 — Add the workflow

Create `.github/workflows/trust-review.yml`:

```yaml
name: Trust Review (TR)
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
  statuses: write
jobs:
  trust-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: pdxlab/trustmodel-review-action@v1
        with:
          api_key: ${{ secrets.TRUSTMODEL_API_KEY }}
          threshold: 70
```

That's it. TR scores every AI-related PR and posts the TrustScore as a PR comment and a `trustmodel/trust-review` status.

**Advisory by default.** Out of the box TR never blocks a merge: a score below your threshold (or a review that could not run) is posted, clearly labelled "Advisory, not enforced", with a green status. The `passed` output stays `false` unless the PR really passed, so a deploy step gated on it still stops.

**To gate merges**, add `mode: enforce` (or `eval: { mode: enforce }` in `.trustmodel.yml`), then make `trustmodel/trust-review` a **required status check** in **Settings → Branches → Branch protection rules**. In enforce mode a below-threshold score fails the status, a service error is an error status, and an unavailable review stays pending.

---

## Why add TR to your AI pipeline?

Standard code review catches logic bugs. It does not catch AI trust regressions.

A PR that looks clean — no syntax errors, tests green, linter happy — can still:

- **Introduce a prompt injection vector** (new system prompt that an adversarial user can override)
- **Regress demographic fairness** (a rephrased instruction that now produces biased outputs for one gender or ethnicity)
- **Break factual accuracy** (a model swap from GPT-4o to a smaller model that hallucinates more on your domain)
- **Leak PII** (a new tool that echoes user data into the response without sanitization)
- **Violate a compliance framework** (an eval script change that removes the EU AI Act transparency check you passed last quarter)

None of these show up in a diff review. All of them ship to production unless you have a trust gate.

**What happens if you skip TR:** AI changes merge without any evaluation. You find out about the regression from users, an auditor, or a press story — not from CI.

---

## What TR surfaces

TR evaluates AI changes across **10 dimensions**. Each maps to concrete failure modes a developer can reproduce:

| Dimension | What it checks | Example failure caught |
|-----------|----------------|------------------------|
| **Safety** | Harmful outputs, prompt injection, jailbreak surface | New system prompt lets users override safety instructions |
| **Fairness** | Demographic bias across groups (gender, race, age) | Rephrased hiring prompt scores male candidates 12 pts higher |
| **Accuracy** | Factual correctness, hallucination rate on your domain | Model swap from GPT-4o → GPT-4o-mini regresses medical Q&A by 8% |
| **Privacy** | PII leakage, data minimization, output sanitization | New retrieval tool echoes SSNs from context into the response |
| **Transparency** | Decision explainability, citation quality | Removed `show_reasoning=True` flag; outputs now unexplainable |
| **Robustness** | Adversarial inputs, edge cases, distribution shift | Adversarial rephrasing causes 23% score variance on same query |
| **Accountability** | Audit trail, human oversight hooks, override paths | Removed human-in-the-loop check for high-stakes decisions |
| **Explainability** | Rationale quality, evidence grounding | RAG answers no longer cite their sources after prompt edit |
| **Compliance** | Regulatory framework alignment (NIST, EU AI Act, etc.) | EU AI Act transparency requirement removed by prompt refactor |
| **Reliability** | Output consistency, latency degradation, failure modes | New retry logic introduces silent truncation on long outputs |

A single PR can regress multiple dimensions simultaneously. TR scores each independently and reports the delta from your baseline.

---

## How TR measures accuracy — and the "correct answer" problem

This is the right question to ask. TR does **not** pretend to know the correct answer to every open-ended question. Instead, it uses three techniques that do not require a universal ground truth:

### 1. Multi-judge consensus
Five independent LLM judges evaluate each response from different angles. No single model's opinion is the verdict — the score requires majority agreement. A judge that consistently disagrees with the consensus is down-weighted in future runs (judge fingerprinting). This eliminates single-model hallucination as a scoring failure.

### 2. Adversarial probes with known ground truth
For safety, fairness, and robustness dimensions, TR uses a library of **probes with known correct/incorrect responses** — adversarial inputs where the right answer is unambiguous:

- Safety probe: a known jailbreak attempt. The correct answer is refusal.
- Fairness probe: the same question with two demographic variations. The correct answer is equal treatment.
- Accuracy probe: a factual question with a verifiable answer (e.g. a drug interaction flagged by FDA).

These are not open-ended. The ground truth is known, reproducible, and version-controlled.

### 3. Domain-specific benchmark sets
For regulated verticals, TR uses certified benchmark sets where "correct" is defined by the domain:

- **HR / hiring**: EEOC-aligned fairness benchmarks. Correct = no statistically significant score difference across protected classes.
- **Lending**: ECOA/FCRA-aligned credit decision probes. Correct = equal treatment under fair lending law.
- **Healthcare**: FDA SaMD-aligned clinical accuracy probes. Correct = matches clinician-verified ground truth.
- **General LLM**: OWASP LLM Top 10 probes. Correct = model does not exhibit the named vulnerability.

**What TR does not claim:** TR does not evaluate whether your product's business logic is correct, whether your model's opinion on a subjective question is right, or whether your system prompt is optimal. Those are engineering decisions. TR evaluates whether your AI system exhibits measurable trust regressions across the 10 dimensions — the things that cause compliance failures, user harm, and regulatory exposure.

---

## Framework support

The `framework` input scopes evaluation to a specific compliance standard. TR maps its 10 dimensions to the requirements of each framework and weights the score accordingly.

| Framework | Input value | Focus |
|-----------|-------------|-------|
| NIST AI RMF | `nist-ai-rmf` | Govern, Map, Measure, Manage |
| EU AI Act | `eu-ai-act` | High-risk system requirements |
| ISO 42001 | `iso-42001` | AI management system |
| OWASP LLM Top 10 | `owasp-llm` | LLM-specific security vulnerabilities |
| NYC Local Law 144 | `nyc-ll144` | Automated employment decision tools |
| EEOC / Fair Hiring | `eeoc` | Demographic bias in hiring AI |
| ECOA / Fair Lending | `ecoa` | Demographic bias in credit AI |
| FDA SaMD | `fda-samd` | Software as a Medical Device |

Omit `framework` to evaluate across all 10 dimensions with equal weighting.

---

## Quickstart

```yaml
# .github/workflows/trust-review.yml
name: Trust Review
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
  statuses: write
concurrency:
  group: trust-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  trust-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: pdxlab/trustmodel-review-action@v1
        with:
          api_key: ${{ secrets.TRUSTMODEL_API_KEY }}
          threshold: 70        # fail the merge if TrustScore < 70
          framework: nist-ai-rmf   # optional: scope to a compliance framework
```

Get an API key at [trustmodel.ai/developers](https://trustmodel.ai/developers). Add it as a repository secret named `TRUSTMODEL_API_KEY`.

**TR only runs when AI-related files change.** Non-AI PRs (pure frontend, infra, docs) are silently skipped — no noise, no false positives.

---

## What TR detects as an "AI change"

By default TR flags these path patterns as AI-related:

- Prompts: `*.prompt`, `prompts/`, `system_prompt*`, `instructions*`
- Agents: `agents/`, `*agent*.py`, `*agent*.ts`
- Evals: `evals/`, `*eval*.py`, `benchmarks/`
- AI SDK imports (v1.3.0+): any changed `.py`, `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs` or `.cjs` file that imports
  an AI SDK — `openai`, `anthropic` / `@anthropic-ai/sdk`, `langchain` / `@langchain/*`, `langgraph`, `llama_index`,
  `litellm`, Google GenAI, Mistral, Cohere, Groq, Ollama, Azure AI / OpenAI, Bedrock runtime, the Vercel AI SDK.
  The file is read **only on your runner** to find the import; only its path is sent to TrustModel.
  Files over 256 KB, binary files and deleted files are skipped. A custom `detect` list turns this off.
- Tool definitions: `tools/`
- Model config: `model_config*`, `llm_config*`

Non-AI paths are excluded automatically: `node_modules/`, `vendor/`, `.venv/`, `dist/`, HTTP user-agent strings.

Override with `.trustmodel.yml` in your repo root:

```yaml
detect:
  - src/ai/**
  - config/models/*.yaml
eval:
  threshold: 75
  framework: eu-ai-act
```

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_key` | No | — | TrustModel API key. Without it the Action registers the PR path metadata but cannot return a score. |
| `threshold` | No | `65` | Minimum TrustScore (0–100) to pass. Server enforces a minimum; your value is a floor, not a ceiling. |
| `framework` | No | all dimensions | Compliance framework to evaluate against (see table above). |
| `detect` | No | AI defaults | Comma-separated glob patterns to override AI-file detection. Setting it also turns off the AI-import scan. |
| `github_token` | No | `${{ github.token }}` | Used only to post PR comments and commit statuses. Never sent to TrustModel. |
| `sarif_file` | No | off | Relative path ending in `.sarif` to write a SARIF 2.1.0 file for Code Scanning. See below. |

---

## Code Scanning (SARIF)

Off by default. Set `sarif_file`, then upload the file with GitHub's own `upload-sarif` action:

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
  statuses: write
  security-events: write   # only needed for the upload step

steps:
  - uses: pdxlab/trustmodel-review-action@v1
    id: tr
    with:
      api_key: ${{ secrets.TRUSTMODEL_API_KEY }}
      sarif_file: trust-review.sarif
  - uses: github/codeql-action/upload-sarif@v3
    if: steps.tr.outputs.sarif_file != ''
    with:
      sarif_file: ${{ steps.tr.outputs.sarif_file }}
      category: trustmodel-review
```

What it reports:

| Result | Code Scanning |
|--------|---------------|
| Score below threshold | `trustmodel/trust-score-below-threshold`: `error` in enforce mode, `warning` in advisory |
| Passed, but a dimension clearly below threshold | `trustmodel/weak-dimension`, `note` |
| Passed cleanly, or no AI files changed | Empty file, so earlier alerts close |
| Unscored, unavailable or service error | No file written (`sarif_file` output is empty) |

- Findings are **file-level** (line 1) on the AI files that were scored. The score covers the whole change, so TR does not claim a specific line.
- A dimension is flagged only when its confidence band stays below the threshold (judge noise is not reported).
- The website score is never a code finding. The file holds only paths, scores and the threshold; no source content.
- Code Scanning on private repositories requires GitHub Advanced Security.

---

## Outputs and PR status

| Situation | Commit status | `passed` output | Notes |
|-----------|---------------|-----------------|-------|
| No AI files changed | `success` (skip) | `false` | Silent skip — no comment, no API call |
| AI files changed, score ≥ threshold | `success` | `true` | Merge unblocked |
| AI files changed, score < threshold | `failure` | `false` | Merge blocked; PR comment shows per-dimension breakdown |
| Evaluator unavailable / no key | `pending` | `false` | Make the check optional to avoid blocking on this |
| Service error | `error` | `false` | Never fails open — a service error does not grant a pass |
| Not run (out of credits, daily limit, API key rejected, too many requests) | `error` | `false` | PR comment says why and what to do (see below) |

In advisory mode (the default) every row except a verified pass publishes `success`, labelled "Advisory, not enforced", so nothing blocks a merge.

### When Trust Review does not run

The PR comment heading says why, and the comment says what to do. It never shows server text.

| Heading | Cause | What to do |
|---------|-------|------------|
| `not run: out of credits` | The organization has used today's free runs and does not have enough credits | Add credits in the TrustModel console (Billing), then re-run. Free runs reset at 00:00 UTC |
| `not run: daily limit reached` | The organization reached today's Trust Review limit | Re-run after 00:00 UTC |
| `not run: too many requests` | Too many requests in a short time | Re-run in a minute |
| `not run: API key rejected` | The key in `api_key` is wrong, disabled or expired | Update the `TRUSTMODEL_API_KEY` secret |
| `not run: evaluation failed` / `service error` | Trust Review could not finish | Re-run the workflow |

The commit status (`trustmodel/trust-review`) is the merge gate — not the Action job exit code. A green Action job with a pending or failed commit status still blocks the merge if the check is required.

---

## Security and privacy

- **File contents never leave your runner.** The Action transmits only file path names. To find AI SDK imports it reads changed source files locally on the runner; that content is never uploaded.
- **Your GitHub token stays on the runner.** It is used only to post comments and statuses to your repo.
- **Evaluation runs server-side on TrustModel infrastructure.** TR fetches your model's public endpoint or uses your registered model config — it does not receive your code.
- **No credential forwarding.** The Action validates that the backend never receives a GitHub token or file content.

---

## Resources

- [TrustModel developer portal](https://trustmodel.ai/developers) — API keys, evaluation reports, dimension methodology
- [TrustScore methodology](https://trustmodel.ai/trustscore-dimensions) — how each dimension is scored
- [Compliance framework crosswalk](https://trustmodel.ai/standards) — NIST / EU AI Act / ISO 42001 mapping
- [GitHub App (zero-YAML install)](https://github.com/apps/trustmodel-review) — install TR on every repo without editing workflow files
