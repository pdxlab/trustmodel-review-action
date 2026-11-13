# Trust Review Action — metadata preview

**The PR diff evaluator is not available. This preview cannot pass a merge gate.**

The Action detects matching changed **file paths** and, when an API key is
configured, records metadata through `POST /v1/pr-trust/review/`. It never reads
or uploads those files' contents. Its GitHub token remains on the runner and is
used only for GitHub comments and commit statuses.

There is no public website scan, no paid/full-evaluation claim, no certificate,
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
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
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
comment and an **error** state for `trustmodel/trust-review`, then fails its job
with that availability message. Do not require this preview check for merging.
Even an empty matching-path list cannot become a passing skip. Without an API
key, the Action reports not available without calling the TrustModel API.

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
evals, chains, and tools; those broad matches transmit names only. An optional
`.trustmodel.yml` can set `detect` and `eval.threshold`/`eval.framework`. The
previous `block_on_regression` and `cert_on_pass` inputs are not supported by this
preview; no regression evaluation or certificate is claimed.

## Development

```bash
npm ci
npm test
npm run build
```

Commit `dist/index.js` and `dist/sourcemap-register.js`. CI rebuilds the bundle
and rejects stale output. Tests cover metadata-only transport, outages without
fallback, false-pass rejection, file deletion/rename detection, and GitHub
publishing order. Deployment end-to-end tests still require QA rollout of both
the Action revision and backend.
