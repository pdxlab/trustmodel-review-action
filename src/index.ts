import * as core from '@actions/core';
import * as github from '@actions/github';
import { DefaultArtifactClient } from '@actions/artifact';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectAiChanges } from './detector';
import { runEval, EvalResult } from './eval';
import { postReviewComment } from './comment';
import { readTrustmodelConfig } from './config';
import { buildSarif } from './sarif';

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
    const sarifEnabled = core.getInput('sarif') !== 'false';

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
    await postReviewComment({ octokit, ctx, prNumber: pr.number, headSha: pr.head.sha, result, cfg, sarifEnabled });

    // 3b. Write SARIF + plain JSON outputs and upload as workflow artifacts.
    //     - tr-results.sarif  → uploadable to GitHub Code Scanning via
    //       github/codeql-action/upload-sarif@v3 (see README for the step).
    //     - tr-result.json    → TRP-conformant plain JSON for downstream steps.
    if (sarifEnabled) {
      try {
        const sarifLog   = buildSarif(result, changedFiles, cfg);
        const sarifJson  = JSON.stringify(sarifLog, null, 2);
        const plainJson  = JSON.stringify(result,   null, 2);

        const tmpDir      = tmpdir();
        const sarifPath   = join(tmpDir, 'tr-results.sarif');
        const plainPath   = join(tmpDir, 'tr-result.json');

        writeFileSync(sarifPath, sarifJson, 'utf8');
        writeFileSync(plainPath, plainJson, 'utf8');

        const client = new DefaultArtifactClient();
        await client.uploadArtifact(
          'trustmodel-trust-review',
          [sarifPath, plainPath],
          tmpDir,
          { retentionDays: 90 },
        );
        core.info('TR: SARIF + JSON artifacts uploaded (trustmodel-trust-review).');
        core.setOutput('sarif_path', sarifPath);
      } catch (artifactErr) {
        // Artifact upload is best-effort — never fail the action over it.
        core.warning(`TR: SARIF artifact upload failed (non-fatal): ${artifactErr}`);
      }
    }

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
