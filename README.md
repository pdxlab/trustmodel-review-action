# Trust Review Action — metadata preview

[![GitHub Marketplace](https://img.shields.io/badge/GitHub%20Marketplace-Trust%20Review%20Action-blue?logo=github)](https://github.com/marketplace/actions/trustmodel-review)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/github/v/release/pdxlab/trustmodel-review-action)](https://github.com/pdxlab/trustmodel-review-action/releases)

**The PR diff evaluator is not available. This preview cannot pass an AI evaluation gate.**

[View on GitHub Marketplace](https://github.com/marketplace/actions/trustmodel-review)

The Action detects matching changed **file paths** and, when an API key is
configured, records metadata through `POST /v1/pr-trust/review/`. It never reads
or uploads those files' contents. Its GitHub token remains on the runner and is
used only for GitHub comments and commit statuses.

There is no automatic website scan, no paid/full-evaluation claim, no certificate,
and no fallback on missing keys, backend errors, HTTP 404/503, network failures,
or polling timeout. A website score is never a PR TrustScore.

## Use the preview

After the companion metadata-only backend is deployed, pin this Action to the
reviewed commit SHA (the existing `v1` tag still contains the older behavior):

```yaml
name: Trust Review preview
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
  issues: write
  statuses: write
concurrency:
  group: trust-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  trust-review:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
          persist-credentials: false
      - uses: pdxlab/trustmodel-review-action@REVIEWED_COMMIT_SHA
        with:
          api_key: ${{ secrets.TRUSTMODEL_API_KEY }}
          base_url: https://YOUR-DEPLOYED-GATEWAY
```

Add the TrustModel key as a repository Actions secret. API-key authentication
currently requires available credits, but this metadata endpoint deducts none.
The optional `github_token` input defaults to `${{ github.token }}`.

**Expected result:** `status=not_available`, `passed=false`,
`pr_diff_evaluated=false`, no score. The Action posts an explicit not-available
comment and a **pending** state for `trustmodel/trust-review`; its Action job
completes without a second red mark. Pending checks still block merges if made
required, so keep this preview optional. Without an API key, the Action reports
not available without calling the PR evaluation API or claiming a dashboard record.
An explicitly configured informational website scan is independent of this.

Only a future response explicitly containing `status=passed`, `passed=true`,
`pr_diff_evaluated=true`, and a valid numeric score can become a passing status.
Thresholds are server-controlled; the Action does not recompute a pass locally.

## Contract and ownership

The backend accepts `repo`, `pr_number`, `base_sha`, `head_sha`, `changed_files`,
`threshold`, and optional `framework`. It rejects `changed_assets`, GitHub
credentials, and client assertions about evaluation. Paths are counted then
discarded. There is no worker or remote scan in this backend release.

The **Action is the publisher**, not the backend. Commit status is posted before
comments, so comment errors cannot suppress the gate. A run for an older PR head
cannot replace the current comment. Configure workflow concurrency as above to
avoid overlapping Action runs. Comment upsert is best-effort, not a transactional
GitHub guarantee across separate workflows or local invocations.

`detect` is a comma-separated list of globs. Defaults include prompts, agents,
evals, chains, and source files under `tools/`; those broad matches transmit names
only. The defaults skip HTTP user-agent files (`user_agent.py`, `UserAgent.ts`) and
dependency or build paths (`node_modules/`, `vendor/`, `.venv/`, `venv/`,
`site-packages/`, `dist/`), decided from the path alone. A custom `detect` list is
used exactly as given, with no exclusions. An optional
`.trustmodel.yml` can set `detect` and `eval.threshold`/`eval.framework`. The
previous `block_on_regression` and `cert_on_pass` inputs are not supported by this
preview; no regression evaluation or certificate is claimed.

## Skip, status, and diagnostics

| Situation | Commit status | Action job | Evaluation outputs |
|---|---|---|---|
| No matching AI paths | success (explicit skip), no comment | succeeds | `status=skipped`, `passed=false`, `pr_diff_evaluated=false` |
| AI paths, evaluator/key unavailable | pending | succeeds | `status=not_available`, `passed=false` |
| Verified evaluation passes | success | succeeds | `passed=true`, `pr_diff_evaluated=true` |
| Verified evaluation fails | failure | succeeds; commit status is the gate | `passed=false` |
| Wrong key, service/transport/validation error | error | succeeds after publishing the error status | `status=error`, `passed=false` |
| Cannot publish a GitHub result | no reliable new status | fails | never grants a pass |

A non-AI skip performs no metadata submission or website scan. A detection error
cannot become a skip. The local CLI uses the same statuses, returning 0 for a
skip/verified pass, 2 for unavailable/failed evaluation, and 3 for setup/API errors.
The green Action job alone is not evaluation evidence: use `passed` or the
`trustmodel/trust-review` commit status. Keep the preview optional.

One `Trust Review response:` log summarizes validated status, evidence, score,
and a valid run ID (or HTTP error code). It never logs raw upstream responses,
source content, API keys, or GitHub tokens.

## Release after merge

Run `gh workflow run release.yml --ref main` after this PR merges. The main-only
workflow repeats tests, checks the committed bundle, releases **v1.0.3**, and
updates **v1** to the exact tested commit with a protective lease. It refuses
to reuse a version tag that belongs to a different commit. See [release notes](RELEASE_NOTES.md).

The app's Install Action buttons open this repository, and its example uses
`@v1`. The new behavior therefore reaches those users only after the release/tag
update. A PR branch or merge by itself does not update Marketplace consumers.

## Optional website TrustScore (informational only)

A website score can be useful context, but it does not assess this PR's code.
Enable it explicitly with an Action input:

```yaml
with:
  api_key: ${{ secrets.TRUSTMODEL_API_KEY }}
  base_url: https://YOUR-DEPLOYED-GATEWAY
  website_domain: your-company.com
```

The Action requests `GET /v1/public/site-score/{domain}/` without a TrustModel
key or GitHub token. It never guesses a domain from the repository owner. The
backend may return a cached website assessment; no before/after PR comparison
or ten-dimension PR review is implied. The comment has a separate **Website
TrustScore — informational** section, explicitly identifying the domain.

Website results use separate `website_domain`, `website_scan_status`, and
`website_trust_score` outputs. They never populate the PR `trust_score`, change
its threshold/status, or make the Action pass. A 100/100 website score still
leaves an unavailable PR evaluator pending with `passed=false`. A website outage never changes
an otherwise verified PR result. This is independently requested information,
not a fallback when PR evaluation fails. Blank `website_domain` disables it.

For the local runner, add `TRUSTREVIEW_WEBSITE_DOMAIN=your-company.com` to
`.trustreviewenv`, or pass `--website-domain your-company.com`. The `--json`
result nests website information under `website_scan`; the PR fields and exit
code are unchanged. `--dry-run` performs no website scan or publication.

## Development

```bash
npm ci
npm test
npm run build
python3 tests/website_e2e.py
```

Commit `dist/index.js` and `dist/sourcemap-register.js`. CI rebuilds the bundle
and rejects stale output. Tests cover metadata-only transport, outages without
fallback, false-pass rejection, file deletion/rename detection, and GitHub
publishing order. Deployment end-to-end tests still require QA rollout of both
the Action revision and backend.
