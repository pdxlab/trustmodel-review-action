import * as core from '@actions/core';
import { readFileSync, existsSync } from 'fs';
import { Config } from './config';

export interface DimensionDelta {
  dimension: string;
  label: string;
  before: number | null;
  after: number;
  delta: number;
  critical: boolean;
}

export interface EvalResult {
  trustScore: number;
  grade: string;
  baseTrustScore?: number;
  dimensionDeltas?: DimensionDelta[];
  complianceGaps?: string[];
  reportUrl?: string;
  certUrl?: string;
  free: boolean;
}

const CRITICAL_DIMS = new Set(['safety', 'fairness', 'privacy', 'compliance']);
const DIM_LABEL: Record<string, string> = {
  safety: 'Safety', fairness: 'Fairness', privacy: 'Privacy',
  accuracy: 'Accuracy', transparency: 'Transparency', compliance: 'Compliance',
  robustness: 'Robustness', reliability: 'Reliability',
  explainability: 'Explainability', accountability: 'Accountability',
  robustness_security: 'Robustness / Security', data_privacy: 'Data Privacy',
  model_safety: 'Model Safety', ai_governance: 'AI Governance',
};

interface RunEvalOpts {
  cfg: Config;
  changedFiles: string[];
  baseSha: string;
  headSha: string;
  repo: string;
  prNumber: number;
}

export async function runEval(opts: RunEvalOpts): Promise<EvalResult> {
  if (!opts.cfg.apiKey) {
    return runPreliminaryScan(opts);
  }
  return runFullEval(opts);
}

// ── Free tier (no API key) ──────────────────────────────────────────────────
// Calls the public site-score endpoint — LIVE TODAY at api.trustmodel.ai.
// Scores the org's public AI surface without any credentials.
// The dev gets a preliminary TrustScore + a prompt to upgrade for the full
// 10-dimension diff-aware eval.
async function runPreliminaryScan({ cfg, repo }: RunEvalOpts): Promise<EvalResult> {
  core.info('No API key provided — running free preliminary TrustScore scan.');
  const org = repo.split('/')[0].toLowerCase();
  const domains = [`${org}.ai`, `${org}.com`, `${org}.io`];

  for (const domain of domains) {
    try {
      const resp = await fetch(
        `${cfg.baseUrl}/v1/public/site-score/${encodeURIComponent(domain)}/`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) }
      );
      if (!resp.ok) continue;
      const d = await resp.json() as {
        trust_score?: number; grade?: string; assessed?: boolean;
        factor_scores?: Record<string, number>;
      };
      if (!d.assessed || d.trust_score == null) continue;
      core.info(`Preliminary scan: ${domain} → ${d.trust_score}/100 (${d.grade})`);
      const dimensionDeltas = Object.entries(d.factor_scores ?? {}).map(([dim, after]) => ({
        dimension: dim,
        label: DIM_LABEL[dim] ?? dim,
        before: null,
        after,
        delta: 0,
        critical: CRITICAL_DIMS.has(dim),
      }));
      return {
        trustScore:  d.trust_score,
        grade:       d.grade ?? 'F',
        dimensionDeltas,
        free: true,
        reportUrl: `https://app.trustmodel.ai?repo=${encodeURIComponent(repo)}`,
      };
    } catch { continue; }
  }

  core.warning('Preliminary scan: no domain found for this org — returning unscored.');
  return { trustScore: 0, grade: 'F', free: true };
}

// ── Full eval (API key provided) ─────────────────────────────────────────────
// Calls POST /v1/pr-trust/review/ with the changed AI file content.
// Falls back to preliminary scan if the backend isn't deployed yet (404/503).
async function runFullEval(opts: RunEvalOpts): Promise<EvalResult> {
  const { cfg, changedFiles, baseSha, headSha, repo, prNumber } = opts;
  core.info(`Running full TrustModel eval (${changedFiles.length} AI file(s) changed)…`);

  const assets = collectAssets(changedFiles);

  const payload = {
    source: 'github_action',
    repo, pr_number: prNumber, base_sha: baseSha, head_sha: headSha,
    changed_assets: assets,
    framework: cfg.framework,
    threshold: cfg.threshold,
    cert_on_pass: cfg.certOnPass,
    github_token: process.env.GITHUB_TOKEN ?? '',
  };

  let resp: Response;
  try {
    resp = await fetch(`${cfg.baseUrl}/v1/pr-trust/review/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': cfg.apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    core.warning(`Full eval request failed (${err}) — falling back to preliminary scan.`);
    return runPreliminaryScan(opts);
  }

  if (resp.status === 404 || resp.status === 503) {
    core.warning(`Full eval endpoint not available (${resp.status}) — falling back to preliminary scan.`);
    return runPreliminaryScan(opts);
  }

  if (!resp.ok) {
    throw new Error(`TrustModel eval API returned ${resp.status}: ${await resp.text()}`);
  }

  // 202 Accepted — poll until complete (bounded by 5-minute timeout).
  const created = await resp.json() as { run_id: string };
  return pollResult(cfg, created.run_id, opts);
}

async function pollResult(cfg: Config, runId: string, opts: RunEvalOpts): Promise<EvalResult> {
  const deadline = Date.now() + 5 * 60_000;
  let wait = 4_000;

  while (Date.now() < deadline) {
    await sleep(wait);
    wait = Math.min(wait * 1.5, 15_000);

    const r = await fetch(`${cfg.baseUrl}/v1/pr-trust/review/${runId}/`, {
      headers: { 'X-API-Key': cfg.apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) continue;

    const d = await r.json() as {
      status: string;
      trust_score?: number; grade?: string;
      base_trust_score?: number;
      factor_scores?: Record<string, number>;
      base_factor_scores?: Record<string, number>;
      compliance_gaps?: string[];
      report_url?: string; cert_url?: string;
    };

    if (d.status === 'running' || d.status === 'pending') continue;
    if (d.status === 'error') throw new Error(`Trust Review eval failed on the server.`);

    const dimensionDeltas = Object.entries(d.factor_scores ?? {}).map(([dim, after]) => {
      const before = d.base_factor_scores?.[dim] ?? null;
      return {
        dimension: dim,
        label: DIM_LABEL[dim] ?? dim,
        before,
        after,
        delta: before !== null ? after - before : 0,
        critical: CRITICAL_DIMS.has(dim),
      };
    });

    return {
      trustScore:     d.trust_score ?? 0,
      grade:          d.grade ?? 'F',
      baseTrustScore: d.base_trust_score,
      dimensionDeltas,
      complianceGaps: d.compliance_gaps,
      reportUrl:      d.report_url,
      certUrl:        d.cert_url,
      free: false,
    };
  }

  core.warning('Trust Review eval timed out — falling back to preliminary scan.');
  return runPreliminaryScan(opts);
}

function collectAssets(files: string[]): Array<{ path: string; content: string }> {
  const MAX_PER_FILE = 32_768;
  const MAX_TOTAL = 500_000;
  let total = 0;
  const result: Array<{ path: string; content: string }> = [];
  for (const f of files.slice(0, 20)) {
    if (!existsSync(f)) continue;
    try {
      const c = readFileSync(f, 'utf8').slice(0, MAX_PER_FILE);
      total += c.length;
      if (total > MAX_TOTAL) break;
      result.push({ path: f, content: c });
    } catch { /* deleted or unreadable — skip */ }
  }
  return result;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
