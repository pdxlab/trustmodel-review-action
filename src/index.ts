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

    // The GitHub Actions SDK types payload.pull_request loosely — cast to what we need.
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

    // 1. Detect which AI-related files changed in this PR.
    const changedFiles = await detectAiChanges({
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      patterns: cfg.detectPatterns,
    });

    if (changedFiles.length === 0) {
      core.info('No AI-related files changed — Trust Review skipped.');
      core.setOutput('passed', 'true');
      core.setOutput('trust_score', '');
      return;
    }

    core.info(`AI-related files changed (${changedFiles.length}): ${changedFiles.join(', ')}`);

    // 2. Run TrustModel eval against the changed assets.
    const repo = `${ctx.repo.owner}/${ctx.repo.repo}`;
    const result: EvalResult = await runEval({
      cfg, changedFiles,
      baseSha: pr.base.sha, headSha: pr.head.sha,
      repo, prNumber: pr.number,
    });

    // 3. Post the Trust Review comment.
    const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
    await postReviewComment({ octokit, ctx, prNumber: pr.number, headSha: pr.head.sha, result, cfg });

    // 4. Set the trustmodel/trust-review commit status check.
    const passed = computePass(result, cfg);
    await octokit.rest.repos.createCommitStatus({
      owner: ctx.repo.owner,
      repo:  ctx.repo.repo,
      sha:   pr.head.sha,
      state:       passed ? 'success' : 'failure',
      context:     'trustmodel/trust-review',
      description: `TR: TrustScore ${result.trustScore}/100 (${result.grade}) — ${passed ? 'passed ✓' : 'failed ✗'}`,
      target_url:  result.reportUrl ?? 'https://app.trustmodel.ai',
    });

    // 5. Outputs for downstream steps.
    core.setOutput('trust_score',      String(result.trustScore));
    core.setOutput('base_trust_score', String(result.baseTrustScore ?? ''));
    core.setOutput('passed',           String(passed));
    core.setOutput('report_url',       result.reportUrl ?? '');

    if (!passed) {
      core.setFailed(
        `Trust Review failed — TrustScore ${result.trustScore}/100 (threshold ${cfg.threshold}). ` +
        `No deploy without a passing TR. See ${result.reportUrl ?? 'https://app.trustmodel.ai'}`
      );
    }
  } catch (err: unknown) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

function computePass(result: EvalResult, cfg: { threshold: number; blockOnRegression: boolean }): boolean {
  if (result.trustScore < cfg.threshold) return false;
  if (cfg.blockOnRegression && result.baseTrustScore !== undefined) {
    const criticalRegressions = result.dimensionDeltas
      ?.filter(d => d.critical && d.delta < -10).length ?? 0;
    if (criticalRegressions > 0) return false;
  }
  return true;
}

run();
