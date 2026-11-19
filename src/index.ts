import * as core from '@actions/core';
import * as github from '@actions/github';
import { detectAiChanges } from './detector';
import { runEval, EvalResult } from './eval';
import { postReviewComment } from './comment';
import { readTrustmodelConfig } from './config';

async function run(): Promise<void> {
  try {
    const ctx = github.context;
    if (ctx.eventName !== 'pull_request') {
      core.info('Not a pull_request event — skipping.');
      return;
    }

    const pr = ctx.payload.pull_request as {
      number: number;
      base: { sha: string };
      head: { sha: string };
    } | undefined;

    if (!pr?.head?.sha || !pr?.base?.sha) {
      core.setFailed('pull_request payload is missing expected fields.');
      return;
    }

    const cfg = await readTrustmodelConfig({
      apiKey:            core.getInput('api_key'),
      threshold:         parseInt(core.getInput('threshold'), 10) || 65,
      framework:         core.getInput('framework') || undefined,
      blockOnRegression: core.getInput('block_on_regression') !== 'false',
      certOnPass:        core.getInput('cert_on_pass') === 'true',
      detectPatterns:    core.getInput('detect').split(',').map(s => s.trim()).filter(Boolean),
      baseUrl:           core.getInput('base_url') || 'https://api.trustmodel.ai',
    });

    const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
    const repo    = `${ctx.repo.owner}/${ctx.repo.repo}`;

    // 1. Detect which AI-related files changed in this PR.
    const changedFiles = await detectAiChanges({
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      patterns: cfg.detectPatterns,
    });

    if (changedFiles.length === 0) {
      // No AI files touched — set a green status check and exit cleanly.
      // Do NOT fail the action step; this is not an error.
      core.info('No AI-related files changed — Trust Review skipped (green).');
      await octokit.rest.repos.createCommitStatus({
        owner: ctx.repo.owner, repo: ctx.repo.repo, sha: pr.head.sha,
        state:       'success',
        context:     'trustmodel/trust-review',
        description: 'TR: No AI-related files changed — skipped',
        target_url:  'https://app.trustmodel.ai',
      });
      core.setOutput('passed', 'true');
      core.setOutput('trust_score', '');
      return;
    }

    core.info(`AI-related files changed (${changedFiles.length}): ${changedFiles.join(', ')}`);

    // 2. Run TrustModel eval against the changed assets.
    const result: EvalResult = await runEval({
      cfg, changedFiles,
      baseSha: pr.base.sha, headSha: pr.head.sha,
      repo, prNumber: pr.number,
    });

    core.info(`Eval result: trustScore=${result.trustScore} grade=${result.grade} free=${result.free}`);

    // 3. Post the Trust Review comment.
    await postReviewComment({ octokit, ctx, prNumber: pr.number, headSha: pr.head.sha, result, cfg });

    // 4. Set the trustmodel/trust-review commit status check.
    //
    //    Three states:
    //    a) Free/preliminary (no API key) or score unavailable → "pending" (yellow).
    //       Never show a red failure when scoring hasn't happened — that would
    //       be a false negative and block merges unfairly.
    //    b) Scored and passed → "success" (green).
    //    c) Scored and failed (score below threshold or critical regression) → "failure" (red).
    //
    //    The action step itself only calls core.setFailed() for case (c) so
    //    there is exactly ONE red signal per PR, not two.

    const noScore  = result.trustScore === 0 && result.free;
    const passed   = !noScore && computePass(result, cfg);

    let checkState: 'success' | 'failure' | 'pending';
    let checkDesc:  string;

    if (noScore || result.free) {
      checkState = 'pending';
      checkDesc  = 'TR: Scoring pending — add TRUSTMODEL_API_KEY for a full 0–100 evaluation';
    } else if (passed) {
      checkState = 'success';
      checkDesc  = `TR: TrustScore ${result.trustScore}/100 (${result.grade}) — passed ✓`;
    } else {
      checkState = 'failure';
      checkDesc  = `TR: TrustScore ${result.trustScore}/100 (${result.grade}) — failed ✗`;
    }

    await octokit.rest.repos.createCommitStatus({
      owner: ctx.repo.owner, repo: ctx.repo.repo, sha: pr.head.sha,
      state:      checkState,
      context:    'trustmodel/trust-review',
      description: checkDesc,
      target_url:  result.reportUrl ?? 'https://app.trustmodel.ai',
    });

    // 5. Outputs for downstream steps.
    core.setOutput('trust_score',      String(result.trustScore));
    core.setOutput('base_trust_score', String(result.baseTrustScore ?? ''));
    core.setOutput('passed',           String(passed));
    core.setOutput('report_url',       result.reportUrl ?? '');

    // Only fail the action STEP (which creates a second red UI mark) when we
    // have a real scored failure — never for "pending/no score" state.
    if (checkState === 'failure') {
      core.setFailed(
        `Trust Review failed — TrustScore ${result.trustScore}/100 (threshold ${cfg.threshold}). ` +
        `No deploy without a passing TR. See ${result.reportUrl ?? 'https://app.trustmodel.ai'}`
      );
    }
  } catch (err: unknown) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Determine whether a dimension delta is a real regression or judge noise.
 *
 * A drop is a real regression only if the CI bands do NOT overlap, i.e.
 *   after_ci_high < before_ci_low
 * which means the entire "after" distribution sits below the entire "before"
 * distribution.  When bands overlap the delta is "within noise" and must not
 * block the gate.
 *
 * Falls back to the legacy >10-point rule when CI data is absent.
 */
function isCriticalRegression(d: {
  delta: number;
  critical: boolean;
  ci_low?: number | null;
  ci_high?: number | null;
  before_ci_low?: number | null;
  before_ci_high?: number | null;
}): boolean {
  if (!d.critical || d.delta >= 0) return false;

  const hasCI = (
    d.ci_low != null && d.ci_high != null &&
    d.before_ci_low != null && d.before_ci_high != null
  );

  if (hasCI) {
    // Real regression: CI bands don't overlap.
    // after_ci_high must be strictly below before_ci_low.
    return (d.ci_high as number) < (d.before_ci_low as number);
  }

  // Legacy fallback: use the hard >10-point threshold.
  return d.delta < -10;
}

function computePass(result: EvalResult, cfg: { threshold: number; blockOnRegression: boolean }): boolean {
  if (result.trustScore < cfg.threshold) return false;
  if (cfg.blockOnRegression && result.baseTrustScore !== undefined) {
    const criticalRegressions = result.dimensionDeltas
      ?.filter(d => isCriticalRegression(d)).length ?? 0;
    if (criticalRegressions > 0) return false;
  }
  return true;
}

run();
