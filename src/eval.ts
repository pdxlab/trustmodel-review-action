import { Config } from './config';

export type EvalStatus = 'not_available' | 'passed' | 'failed' | 'error';
export interface EvalResult {
  status: EvalStatus;
  passed: boolean;
  prDiffEvaluated: boolean;
  trustScore: number | null;
  grade: string | null;
  message: string;
  reportUrl?: string;
  runId?: string;
}
export const unavailable = (message = 'PR diff evaluation is not available. No code was evaluated.'): EvalResult => ({
  status: 'not_available', passed: false, prDiffEvaluated: false, trustScore: null, grade: null, message,
});
export const evaluationError = (): EvalResult => ({ ...unavailable('Trust Review service could not complete the request. No passing gate was issued.'), status: 'error' });
export const verifiedPass = (r: EvalResult): boolean => r.status === 'passed' && r.passed === true && r.prDiffEvaluated === true;

export function parseResult(data: unknown): EvalResult {
  if (!data || typeof data !== 'object') throw new Error('Invalid Trust Review API response.');
  const d = data as Record<string, unknown>;
  if (!['not_available', 'passed', 'failed', 'error'].includes(String(d.status))) throw new Error('Unknown Trust Review status.');
  if (d.passed !== false && d.passed !== true) throw new Error('API response is missing its gate decision.');
  if (d.pr_diff_evaluated !== false && d.pr_diff_evaluated !== true) throw new Error('API response is missing evaluation evidence.');
  if ((d.status === 'passed' || d.passed === true) && !(d.status === 'passed' && d.passed === true && d.pr_diff_evaluated === true
      && typeof d.trust_score === 'number' && Number.isFinite(d.trust_score) && d.trust_score >= 0 && d.trust_score <= 100)) {
    throw new Error('Unverified or inconsistent passing result rejected.');
  }
  return {
    status: d.status as EvalStatus, passed: d.passed, prDiffEvaluated: d.pr_diff_evaluated,
    trustScore: d.pr_diff_evaluated && typeof d.trust_score === 'number' ? d.trust_score : null,
    grade: d.pr_diff_evaluated && typeof d.grade === 'string' ? d.grade : null,
    message: d.status === 'not_available' ? unavailable().message : d.status === 'error' ? evaluationError().message : 'PR diff evaluation completed.',
    reportUrl: typeof d.report_url === 'string' && /^https:\/\//.test(d.report_url) ? d.report_url : undefined,
    runId: typeof d.run_id === 'string' ? d.run_id : undefined,
  };
}

export interface RunEvalOpts {
  cfg: Config; changedFiles: string[]; baseSha: string; headSha: string; repo: string; prNumber: number;
  transport?: typeof fetch; timeoutMs?: number; pollIntervalMs?: number;
}
export async function runEval(opts: RunEvalOpts): Promise<EvalResult> {
  if (!opts.cfg.apiKey) return unavailable('PR diff evaluation is not available. An API key is required to record metadata.');
  const transport = opts.transport ?? fetch;
  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  const headers = { 'Content-Type': 'application/json', 'X-API-Key': opts.cfg.apiKey };
  const response = await transport(`${opts.cfg.baseUrl}/v1/pr-trust/review/`, {
    method: 'POST', headers,
    body: JSON.stringify({ repo: opts.repo, pr_number: opts.prNumber, base_sha: opts.baseSha, head_sha: opts.headSha,
                           changed_files: opts.changedFiles, threshold: opts.cfg.threshold, framework: opts.cfg.framework ?? '' }),
    signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
  });
  if (!response.ok) throw new Error(`Trust Review API returned HTTP ${response.status}; no fallback assessment was performed.`);
  let data = await response.json() as Record<string, unknown>;
  const runId = data.run_id;
  while (data.status === 'running' || data.status === 'pending') {
    if (typeof runId !== 'string' || !/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('Missing review identifier.');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Trust Review timed out; no fallback assessment was performed.');
    await new Promise(resolve => setTimeout(resolve, Math.min(opts.pollIntervalMs ?? 3000, remaining)));
    if (Date.now() >= deadline) throw new Error('Trust Review timed out; no fallback assessment was performed.');
    const poll = await transport(`${opts.cfg.baseUrl}/v1/pr-trust/review/${runId}/`, {
      headers: { 'X-API-Key': opts.cfg.apiKey }, signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))),
    });
    if (!poll.ok) throw new Error(`Trust Review polling returned HTTP ${poll.status}; no fallback assessment was performed.`);
    data = await poll.json() as Record<string, unknown>;
  }
  return parseResult(data);
}
