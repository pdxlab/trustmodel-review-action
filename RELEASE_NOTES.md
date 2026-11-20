# v1.0.3

- Default AI-file detection skips known false positives, decided from the path
  alone: HTTP user-agent files (`user_agent.py`, `user-agent.ts`, `UserAgent.ts`,
  `useragent_parser.js`) and dependency/build paths (`node_modules/`, `vendor/`,
  `.venv/`, `venv/`, `site-packages/`, `dist/`). `tools/` now matches source files
  only (`.py`, `.ts`, `.js`). PRs that only touch these paths now get the quiet
  non-AI skip (successful status, no comment) instead of a pending review.
- A custom `detect` list is used exactly as given, with no exclusions.
- Source content is still never read or uploaded; statuses, outputs and the API
  contract are unchanged. The PR diff evaluator has still not shipped.

Run `gh workflow run release.yml --ref main` after this merges to publish v1.0.3
and move the floating v1 tag.

# v1.0.2

- Node 24 runtime and CI.
- Quiet non-AI skip: successful commit status, no comment, no API/website request;
  `status=skipped`, `passed=false`, `pr_diff_evaluated=false`.
- Unavailable AI evaluation: pending commit status, successful Action job,
  `passed=false`. Pending checks still block merging if made required.
- Verified passes/failures and service errors use the commit status as the gate;
  publication failures fail the Action job. No website score can pass PR review.
- Path-only API contract, credentials kept on the client, sanitized result log.
- Optional explicit-domain website score, clearly labelled informational.

The PR diff evaluator has not shipped. This release does not add ten-dimension
code review, certificates, or scored reports to the dashboard. A no-key run
does not create a backend receipt. Keep this preview optional.

After merging PR #1, run `gh workflow run release.yml --ref main` in this repo.
The workflow tests main, verifies dist, publishes the version in package.json,
and updates the floating v1 tag with a lease. It cannot release a PR branch.
The console's Install Action buttons open this repository, and its snippet uses
@v1, so updating v1 is necessary for that snippet and existing workflows to use
the fix. Nothing should move the release tag before the PR is merged.
