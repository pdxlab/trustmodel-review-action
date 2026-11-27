import { Config, ReviewMode } from './config';

export type EvalStatus = 'skipped' | 'not_available' | 'passed' | 'failed' | 'error';
export interface EvalResult {
  status: EvalStatus;
  passed: boolean;
  prDiffEvaluated: boolean;
  trustScore: number | null;
  grade: string | null;
  message: string;
  reportUrl?: string;
  runId?: string;
  // TRUS-2596: only for an evaluated result. The threshold the server applied
  // and its per-dimension scores (dimension_variance), used for SARIF output.
  threshold?: number;
  dimensions?: DimensionScore[];
  // Why nothing was scored, when the Action knows. Chosen only from status
  // codes and reason codes, never from server text (see comment.ts).
  reason?: NotRunReason;
}
export type NotRunReason = 'insufficient_credits' | 'daily_limit' | 'rate_limited' | 'api_key_rejected'
  | 'service_error' | 'evaluation_error';
export interface DimensionScore { name: string; score: number; ciHigh: number | null }
const isScore = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
// Extra detail, never a gate input: a malformed entry is dropped, never an error.
export function parseDimensions(raw: unknown): DimensionScore[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter(([name, v]) => /^[a-z][a-z0-9_]{0,39}$/.test(name) && !!v && typeof v === 'object' && isScore((v as Record<string, unknown>).score))
    .slice(0, 20)
    .map(([name, v]) => {
      const { score, ci_high: ciHigh } = v as Record<string, unknown>;
      return { name, score: score as number, ciHigh: isScore(ciHigh) ? ciHigh : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
export const unavailable = (message = 'PR diff evaluation is not available. No code was evaluated.'): EvalResult => ({
  status: 'not_available', passed: false, prDiffEvaluated: false, trustScore: null, grade: null, message,
});
export const evaluationError = (): EvalResult => ({ ...unavailable('Trust Review service could not complete the request. No passing gate was issued.'), status: 'error' });
// An error result that says why. Same gate as any error: never a pass.
export const notRun = (reason: NotRunReason, runId?: string): EvalResult => ({ ...evaluationError(), reason, runId });
// Why a non-2xx answer means nothing was scored: out of credits (402), daily
// limit or plain throttling (429), a rejected key (401/403), else a service
// error. Only the status and the reason code are read; server text never is.
const REFUSAL_CODES: Record<string, NotRunReason> = { insufficient_credits: 'insufficient_credits', tr_daily_limit_reached: 'daily_limit' };
async function refusal(response: Response): Promise<never> {
  const status = response.status;
  if (status === 401 || status === 403) throw new ReviewApiError(status, 'api_key_rejected');
  if (status !== 402 && status !== 429) throw new ReviewApiError(status, 'service_error');
  let body: Record<string, unknown> = {};
  try { body = await response.json() as Record<string, unknown>; } catch { /* no usable body */ }
  const runId = typeof body.run_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.run_id) ? body.run_id : undefined;
  const reason = typeof body.code === 'string' ? REFUSAL_CODES[body.code] : undefined;
  throw new ReviewApiError(status, reason ?? (status === 429 ? 'rate_limited' : 'service_error'), runId);
}
export const verifiedPass = (r: EvalResult): boolean => r.status === 'passed' && r.passed === true && r.prDiffEvaluated === true;
export const skipped = (): EvalResult => ({ ...unavailable('No AI-related files changed; review skipped. No code was evaluated.'), status: 'skipped' });
export function commitState(r: EvalResult, mode: ReviewMode = 'enforce'): 'success' | 'pending' | 'failure' | 'error' {
  if (r.status === 'skipped' || verifiedPass(r)) return 'success';
  // Advisory never blocks or hangs a merge. The status description and the
  // `passed` output still say the PR was not verified (see comment.ts).
  if (mode === 'advisory') return 'success';
  if (r.status === 'not_available') return 'pending';
  return r.status === 'failed' && r.prDiffEvaluated ? 'failure' : 'error';
}
export class ReviewApiError extends Error {
  constructor(readonly httpStatus: number, readonly reason: NotRunReason = 'service_error', readonly runId?: string) {
    super(`Trust Review API returned HTTP ${httpStatus}.`);
  }
}

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
  // TRUS-2605: the gateway found no AI-related file among the submitted paths, so
  // there was nothing to score. Treat it exactly like this Action's own no-AI skip
  // (success status, no comment). Only the reason code is used, never server text,
  // and only for an unevaluated, non-passing not_available answer.
  if (d.status === 'not_available' && d.reason === 'no_ai_changes' && d.passed === false && d.pr_diff_evaluated === false) {
    return { ...skipped(), runId: typeof d.run_id === 'string' ? d.run_id : undefined };
  }
  return {
    status: d.status as EvalStatus, passed: d.passed, prDiffEvaluated: d.pr_diff_evaluated,
    trustScore: d.pr_diff_evaluated && typeof d.trust_score === 'number' ? d.trust_score : null,
    grade: d.pr_diff_evaluated && typeof d.grade === 'string' ? d.grade : null,
    message: d.status === 'not_available' ? unavailable().message : d.status === 'error' ? evaluationError().message : 'PR diff evaluation completed.',
    reportUrl: typeof d.report_url === 'string' && /^https:\/\//.test(d.report_url) ? d.report_url : undefined,
    runId: typeof d.run_id === 'string' ? d.run_id : undefined,
    ...(d.status === 'error' ? { reason: 'evaluation_error' as const } : {}),
    ...(d.pr_diff_evaluated ? {
      threshold: Number.isInteger(d.threshold) && (d.threshold as number) >= 1 && (d.threshold as number) <= 100 ? d.threshold as number : undefined,
      dimensions: parseDimensions(d.dimension_variance),
    } : {}),
  };
}

export interface RunEvalOpts {
  cfg: Config; changedFiles: string[]; baseSha: string; headSha: string; repo: string; prNumber: number;
  // TRUS-2642: paths found by an AI SDK import on this runner. Paths only.
  importMatchedFiles?: string[];
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
                           changed_files: opts.changedFiles, threshold: opts.cfg.threshold, framework: opts.cfg.framework ?? '',
                           // Sent only when non-empty, so such a PR's request is unchanged for older gateways.
                           ...(opts.importMatchedFiles?.length ? { import_matched_files: opts.importMatchedFiles } : {}) }),
    signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
  });
  if (!response.ok) await refusal(response);
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
    if (!poll.ok) await refusal(poll);
    data = await poll.json() as Record<string, unknown>;
  }
  return parseResult(data);
}
