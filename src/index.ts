import * as core from '@actions/core';
import * as github from '@actions/github';
import { detectAiChanges } from './detector';
import { runEval, EvalResult, verifiedPass, evaluationError } from './eval';
import { publishResult } from './comment';
import { readTrustmodelConfig } from './config';

export async function run(): Promise<void> {
  const ctx = github.context;
  if (ctx.eventName !== 'pull_request') {
    core.setOutput('status', 'not_applicable'); core.setOutput('passed', 'false');
    core.info('This action requires a pull_request event. No passing gate was issued.');
    return;
  }
  const pr = ctx.payload.pull_request as { number: number; base: { sha: string }; head: { sha: string } } | undefined;
  if (!pr || !Number.isInteger(pr.number) || pr.number <= 0 || ![pr.head?.sha, pr.base?.sha].every(sha => /^[0-9a-f]{40}$/i.test(sha))) {
    core.setFailed('Invalid pull_request metadata.'); return;
  }
  const githubToken = core.getInput('github_token') || process.env.GITHUB_TOKEN || '';
  const apiKey = core.getInput('api_key');
  if (apiKey) core.setSecret(apiKey);
  if (githubToken) core.setSecret(githubToken);
  let result: EvalResult;
  try {
    const input = core.getInput('threshold');
    if (input && !/^[0-9]+$/.test(input)) throw new Error('Invalid threshold.');
    const cfg = await readTrustmodelConfig({ apiKey, threshold: input ? Number(input) : undefined,
      framework: core.getInput('framework') || undefined, detectPatterns: core.getInput('detect').split(',').map(s => s.trim()).filter(Boolean),
      baseUrl: core.getInput('base_url') || 'https://api.trustmodel.ai' });
    const changedFiles = await detectAiChanges({ baseSha: pr.base.sha, headSha: pr.head.sha, patterns: cfg.detectPatterns });
    core.info(`Detected ${changedFiles.length} matching file path(s). Source content is never read or uploaded.`);
    result = await runEval({ cfg, changedFiles, baseSha: pr.base.sha, headSha: pr.head.sha,
                             repo: `${ctx.repo.owner}/${ctx.repo.repo}`, prNumber: pr.number });
  } catch {
    // Do not echo upstream error text or substitute a website scan.
    result = evaluationError();
  }
  core.setOutput('status', result.status);
  core.setOutput('passed', String(verifiedPass(result)));
  core.setOutput('pr_diff_evaluated', String(result.prDiffEvaluated));
  core.setOutput('trust_score', result.trustScore === null ? '' : String(result.trustScore));
  core.setOutput('report_url', result.reportUrl ?? '');
  try {
    if (!githubToken) throw new Error('missing GitHub credential');
    await publishResult({ octokit: github.getOctokit(githubToken), owner: ctx.repo.owner, repo: ctx.repo.repo,
                          prNumber: pr.number, headSha: pr.head.sha, result });
  } catch {
    core.setFailed('GitHub publication failed; check token permissions. No alternate passing status was issued.');
    return;
  }
  if (!verifiedPass(result)) core.setFailed(result.message);
}

if (require.main === module) void run();
