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
      number: number; base: { sha: string }; head: { sha: string };
    } | undefined;

    if (!pr?.head?.sha || !pr?.base?.sha) {
      core.setFailed('pull_request payload is missing expected fields.');
      return;
    }

    const cfg = await readTrustmodelConfig({
      apiKey:            core.getInput('api_key'),
      mode:              (core.getInput('mode') || 'advisory') as 'advisory' | 'enforce',
      threshold:         parseInt(core.getInput('threshold'), 10) || 65,
      framework:         core.getInput('framework') || undefined,
      blockOnRegression: core.getInput('block_on_regression') !== 'false',
      certOnPass:        core.getInput('cert_on_pass') === 'true',
      detectPatterns:    core.getInput('detect').split(',').map((s: string) => s.trim()).filter(Boolean),
      detectDebug:       core.getInput('detect_debug') === 'true',
      baseUrl:           core.getInput('base_url') || 'https://api.trustmodel.ai',
    });

    core.info(`TR mode: ${cfg.mode}`);

    const changedFiles = await detectAiChanges({
      baseSha: pr.base.sha, headSha: pr.head.sha,
      patterns: cfg.detectPatterns, debug: cfg.detectDebug,
    });

    const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
    const repo    = `${ctx.repo.owner}/${ctx.repo.repo}`;

    if (changedFiles.length === 0) {
      core.info('No AI-related files changed — Trust Review skipped.');
      await octokit.rest.repos.createCommitStatus({
        owner: ctx.repo.owner, repo: ctx.repo.repo, sha: pr.head.sha,
        state: 'success', context: 'trustmodel/trust-review',
        description: 'TR: No AI-related files changed — skipped',
        target_url: 'https://app.trustmodel.ai',
      });
      core.setOutput('passed', 'true');
      core.setOutput('trust_score', '');
      return;
    }

    core.info(`AI-related files changed (${changedFiles.length}): ${changedFiles.join(', ')}`);

    const result: EvalResult = await runEval({
      cfg, changedFiles,
      baseSha: pr.base.sha, headSha: pr.head.sha,
      repo, prNumber: pr.number,
    });

    core.info(`Eval: trustScore=${result.trustScore} grade=${result.grade} free=${result.free}`);

    await postReviewComment({ octokit, ctx, prNumber: pr.number, headSha: pr.head.sha, result, cfg });

    // advisory → always neutral/success; enforce → failure when gate fails
    const noScore   = result.free || (result.trustScore === 0 && !result.grade);
    const scored    = !noScore;
    const failsGate = scored && !computePass(result, cfg);

    let checkState: 'success' | 'failure' | 'pending';
    let checkDesc: string;

    if (noScore) {
      checkState = 'pending';
      checkDesc  = 'TR: Scoring pending — add TRUSTMODEL_API_KEY for a full 0–100 evaluation';
    } else if (cfg.mode === 'advisory') {
      checkState = 'success';
      checkDesc  = `TR (advisory): ${result.trustScore}/100 (${result.grade}) — regressions shown as ⚠️`;
    } else if (failsGate) {
      checkState = 'failure';
      checkDesc  = `TR: ${result.trustScore}/100 (${result.grade}) — failed ✗`;
    } else {
      checkState = 'success';
      checkDesc  = `TR: ${result.trustScore}/100 (${result.grade}) — passed ✓`;
    }

    await octokit.rest.repos.createCommitStatus({
      owner: ctx.repo.owner, repo: ctx.repo.repo, sha: pr.head.sha,
      state: checkState, context: 'trustmodel/trust-review',
      description: checkDesc,
      target_url: result.reportUrl ?? 'https://app.trustmodel.ai',
    });

    core.setOutput('trust_score',      String(result.trustScore));
    core.setOutput('base_trust_score', String(result.baseTrustScore ?? ''));
    core.setOutput('passed',           String(!failsGate));
    core.setOutput('report_url',       result.reportUrl ?? '');
    core.setOutput('mode',             cfg.mode);

    // Only fail the action step in enforce mode with a real scored failure.
    if (cfg.mode === 'enforce' && failsGate && scored) {
      core.setFailed(
        `Trust Review failed — ${result.trustScore}/100 (threshold ${cfg.threshold}). ` +
        `Use mode: advisory to unblock while you investigate. ` +
        `Report: ${result.reportUrl ?? 'https://app.trustmodel.ai'}`
      );
    }
  } catch (err: unknown) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

function computePass(result: EvalResult, cfg: { threshold: number; blockOnRegression: boolean }): boolean {
  if (result.trustScore < cfg.threshold) return false;
  if (cfg.blockOnRegression && result.baseTrustScore !== undefined) {
    const critRegressions = result.dimensionDeltas
      ?.filter((d: { critical: boolean; delta: number }) => d.critical && d.delta < -10).length ?? 0;
    if (critRegressions > 0) return false;
  }
  return true;
}

run();
