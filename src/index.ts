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

    const pr = ctx.payload.pull_request!;
    const cfg = await readTrustmodelConfig({
      apiKey:            core.getInput('api_key'),
      threshold:         parseInt(core.getInput('threshold'), 10),
      framework:         core.getInput('framework') || undefined,
      blockOnRegression: core.getInput('block_on_regression') !== 'false',
      certOnPass:        core.getInput('cert_on_pass') === 'true',
      detectPatterns:    core.getInput('detect').split(',').map(s => s.trim()).filter(Boolean),
      baseUrl:           core.getInput('base_url'),
    });

    // 1. Detect which AI-related files changed in this PR.
    const changedFiles = await detectAiChanges({
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      patterns: cfg.detectPatterns,
    });

    if (changedFiles.length === 0) {
      core.info('No AI-related files changed — skipping TrustModel review.');
      core.setOutput('passed', 'true');
      return;
    }

    core.info(`AI-related files changed: ${changedFiles.join(', ')}`);

    // 2. Run TrustModel eval against the changed assets.
    const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
    const result: EvalResult = await runEval({
      cfg,
      changedFiles,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      repo: `${ctx.repo.owner}/${ctx.repo.repo}`,
      prNumber: pr.number,
    });

    // 3. Post the PR review comment with the TrustScore diff.
    await postReviewComment({ octokit, ctx, pr, result, cfg });

    // 4. Set the commit status check.
    const passed = computePass(result, cfg);
    await octokit.rest.repos.createCommitStatus({
      owner: ctx.repo.owner,
      repo:  ctx.repo.repo,
      sha:   pr.head.sha,
      state:       passed ? 'success' : 'failure',
      context:     'trustmodel/trust-score',
      description: `TrustScore ${result.trustScore}/100 (${result.grade}) — ${passed ? 'passed' : 'failed'}`,
      target_url:  result.reportUrl,
    });

    // 5. Set outputs.
    core.setOutput('trust_score',      String(result.trustScore));
    core.setOutput('base_trust_score', String(result.baseTrustScore ?? ''));
    core.setOutput('passed',           String(passed));
    core.setOutput('report_url',       result.reportUrl ?? '');

    if (!passed) core.setFailed(`TrustModel gate failed — score ${result.trustScore} (threshold ${cfg.threshold})`);
  } catch (err: unknown) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

function computePass(result: EvalResult, cfg: { threshold: number; blockOnRegression: boolean }): boolean {
  if (result.trustScore < cfg.threshold) return false;
  if (cfg.blockOnRegression && result.baseTrustScore !== undefined) {
    const regressionOnCritical = result.dimensionDeltas
      ?.filter(d => d.critical && d.delta < -10)
      .length ?? 0;
    if (regressionOnCritical > 0) return false;
  }
  return true;
}

run();
