import * as core from '@actions/core';
import * as github from '@actions/github';
import { detectAiChangeSet } from './detector';
import { runEval, EvalResult, verifiedPass, notRun, skipped, ReviewApiError } from './eval';
import { publishResult } from './comment';
import { readTrustmodelConfig, ReviewMode } from './config';
import { normalizeWebsiteDomain, scanWebsite, WebsiteResult } from './website';
import { buildSarif, resolveSarifPath, scoredFiles, writeSarif } from './sarif';

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
  let website: WebsiteResult | undefined;
  let websiteRequest: { baseUrl: string; domain: string } | undefined;
  let httpStatus: number | undefined;
  // Fail safe: until the configuration has been read and validated, a
  // problem is reported as enforce (a visible failure), never as advisory.
  let mode: ReviewMode = 'enforce';
  let changedFiles: string[] = [];
  let threshold = 65;
  try {
    const input = core.getInput('threshold');
    if (input && !/^[0-9]+$/.test(input)) throw new Error('Invalid threshold.');
    const cfg = await readTrustmodelConfig({ apiKey, threshold: input ? Number(input) : undefined,
      framework: core.getInput('framework') || undefined, detectPatterns: core.getInput('detect').split(',').map(s => s.trim()).filter(Boolean),
      baseUrl: core.getInput('base_url') || 'https://api.trustmodel.ai', mode: core.getInput('mode') || undefined });
    mode = cfg.mode;
    threshold = cfg.threshold;
    core.info(`Trust Review mode: ${mode}.`);
    const detected = await detectAiChangeSet({ baseSha: pr.base.sha, headSha: pr.head.sha, patterns: cfg.detectPatterns });
    changedFiles = [...detected.pathMatched, ...detected.importMatched];
    core.info(`Detected ${detected.pathMatched.length} AI file path(s) and ${detected.importMatched.length} file(s) importing an AI SDK. `
              + 'File contents are read only on this runner to find imports and are never uploaded.');
    if (!changedFiles.length) {
      result = skipped();
    } else {
      const domain = core.getInput('website_domain');
      if (domain) websiteRequest = { baseUrl: cfg.baseUrl, domain: normalizeWebsiteDomain(domain) };
      result = await runEval({ cfg, changedFiles: detected.pathMatched, importMatchedFiles: detected.importMatched,
                             baseSha: pr.base.sha, headSha: pr.head.sha,
                             repo: `${ctx.repo.owner}/${ctx.repo.repo}`, prNumber: pr.number });
    }
  } catch (error) {
    // Do not echo upstream error text or substitute a website scan.
    if (error instanceof ReviewApiError) httpStatus = error.httpStatus;
    result = error instanceof ReviewApiError ? notRun(error.reason, error.runId) : notRun('service_error');
  }
  core.info(`Trust Review response: ${JSON.stringify({ status: result.status, passed: verifiedPass(result),
    pr_diff_evaluated: result.prDiffEvaluated, trust_score: result.trustScore,
    run_id: result.runId && /^[0-9a-f-]{36}$/i.test(result.runId) ? result.runId : undefined, http_status: httpStatus })}`);
  // Independent, explicitly requested information. Never substitute it for runEval.
  if (websiteRequest) website = await scanWebsite(websiteRequest);
  core.setOutput('website_domain', website?.domain ?? '');
  core.setOutput('website_scan_status', website?.status ?? 'disabled');
  core.setOutput('website_trust_score', website?.trustScore === null || !website ? '' : String(website.trustScore));
  core.setOutput('status', result.status);
  core.setOutput('mode', mode);
  core.setOutput('passed', String(verifiedPass(result)));
  core.setOutput('pr_diff_evaluated', String(result.prDiffEvaluated));
  core.setOutput('trust_score', result.trustScore === null ? '' : String(result.trustScore));
  core.setOutput('report_url', result.reportUrl ?? '');
  // TRUS-2596: opt-in SARIF for Code Scanning. Reporting only: it can never
  // change the commit status, the comment or the `passed` output.
  let sarifFile = '';
  const sarifInput = core.getInput('sarif_file');
  if (sarifInput) {
    try {
      const workspace = process.cwd();
      const target = resolveSarifPath(sarifInput, workspace);
      const sarif = buildSarif({ result, files: scoredFiles(changedFiles, workspace), mode, threshold });
      if (sarif) {
        writeSarif(target, sarif, workspace);
        sarifFile = sarifInput;
        core.info(`Wrote SARIF to ${sarifInput}.`);
      } else {
        core.info('No SARIF written: this run has no scored Trust Review result to report.');
      }
    } catch {
      core.warning('SARIF was not written; check the sarif_file input. The Trust Review result is unchanged.');
    }
  }
  core.setOutput('sarif_file', sarifFile);
  try {
    if (!githubToken) throw new Error('missing GitHub credential');
    await publishResult({ octokit: github.getOctokit(githubToken), owner: ctx.repo.owner, repo: ctx.repo.repo,
                          prNumber: pr.number, headSha: pr.head.sha, result, website, mode });
  } catch {
    core.setFailed('GitHub publication failed; check token permissions. No alternate passing status was issued.');
    return;
  }
  // The commit status is the gate. Avoid a duplicate red Action job when the
  // result was published; publication failures above still fail the job.
  if (!verifiedPass(result)) core.warning(result.message);
}

if (require.main === module) void run();
