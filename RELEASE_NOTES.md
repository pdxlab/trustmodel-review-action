# v1.3.0 — AI code found by its imports, not only its path (TRUS-2642)

- A changed source file (`.py .js .jsx .ts .tsx .mjs .cjs`) that matches no path
  rule but imports an AI SDK (openai, anthropic, langchain, llama_index, litellm,
  Google GenAI, Mistral, Cohere, Groq, Ollama, Azure AI, Bedrock runtime, Vercel
  AI SDK) now counts as an AI change. Before, `src/services/openai_client.py` was
  skipped as "no AI-related files changed".
- The file is read with `git` on your runner only. Only its path is sent, in a
  new `import_matched_files` field; content is never uploaded.
- Bounded: at most 300 candidate files, 256 KB each; binary and deleted files are
  skipped; dependency, build and user-agent paths stay excluded. A git error
  falls back to path rules only.
- A custom `detect` list turns the import scan off.
- Requires a gateway that accepts `import_matched_files`. A PR with no import
  matches sends exactly the same request as v1.2.1.

# v1.2.1 — the PR says why Trust Review did not run (TRUS-2593)

- When Trust Review cannot score a PR, the comment heading and commit status now
  say why: out of credits (402 `insufficient_credits`), daily limit reached (429
  `tr_daily_limit_reached`), too many requests (429), API key rejected (401/403),
  evaluation failed, or service error. Each comes with what to do next.
  Previously every one of these read as "evaluator not available" or "service error".
- Chosen from the HTTP status and reason code only; server text is never shown.
- Gate unchanged: each is an `error` result, never a pass. Advisory mode stays
  green; enforce mode shows `error`.

# v1.2.0 — SARIF output for GitHub Code Scanning (TRUS-2596)

- New optional `sarif_file` input (off by default) writes a SARIF 2.1.0 file,
  and a `sarif_file` output gives its path. Upload it with
  `github/codeql-action/upload-sarif` (see README, "Code Scanning (SARIF)").
- Below threshold: an `error` in enforce mode, a `warning` in advisory. A pass
  with a dimension clearly below threshold: a `note`. Clean pass or no AI
  files: an empty file, so earlier alerts close. Unscored or error: no file.
- Findings are file-level on the scored AI files (the score covers the whole
  change). Dimensions within judge noise are not reported. Website scores are
  never findings. The SARIF step never changes the status, comment or `passed`.
- No new dependencies and no workflow artifact.

# v1.1.1 — "no AI files changed" is a quiet skip (TRUS-2605)

- When the gateway reports that none of the submitted paths are AI-related
  (`reason: no_ai_changes`), the Action now treats it exactly like its own
  no-AI skip: a success status "TR: No AI-related files changed — skipped",
  no PR comment, `status=skipped`, `passed=false`. Previously this showed
  "The PR diff evaluator is not available", which read as an outage.
- Honoured only for an unevaluated, non-passing `not_available` answer; the
  server's message text is never displayed.

# v1.1.0 — advisory mode by default (TRUS-2595)

- New `mode` input (`advisory` | `enforce`), also settable as `eval.mode` in
  `.trustmodel.yml`. Precedence: input, then the file, then `advisory`.
- **advisory (default):** never blocks or hangs a merge. Every result publishes a
  `success` status; anything that did not verifiably pass is described as
  "Advisory, not enforced: …" (with the score when there is one), and the PR
  comment says it is not blocking.
- **enforce:** exactly the v1.0.x gate: below threshold = `failure`, service
  error = `error`, unavailable = `pending`.
- The `passed` output is unchanged in both modes: `true` only for a
  server-verified pass. New `mode` output.
- An invalid `mode` is a configuration error, reported as enforce (never
  silently advisory).
- **Behaviour change for `@v1` users:** a below-threshold PR is now green unless
  you set `mode: enforce`. If you rely on TR blocking merges, add it.

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
