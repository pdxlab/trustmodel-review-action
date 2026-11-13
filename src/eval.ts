import * as core from '@actions/core';
import { readFileSync } from 'fs';
import { Config } from './config';

export interface DimensionDelta {
  dimension: string;
  before: number | null;
  after: number;
  delta: number;
  critical: boolean;  // Safety, Fairness, Privacy, Compliance
}

export interface EvalResult {
  trustScore: number;
  grade: string;
  baseTrustScore?: number;
  dimensionDeltas?: DimensionDelta[];
  complianceGaps?: string[];
  reportUrl?: string;
  certUrl?: string;
  free: boolean;    // true = preliminary scan (no API key)
}

const CRITICAL_DIMS = new Set(['safety', 'fairness', 'privacy', 'compliance']);

interface RunEvalOptions {
  cfg: Config;
  changedFiles: string[];
  baseSha: string;
  headSha: string;
  repo: string;
  prNumber: number;
}

export async function runEval({ cfg, changedFiles, baseSha, headSha, repo, prNumber }: RunEvalOptions): Promise<EvalResult> {
  if (!cfg.apiKey) {
    return runPreliminaryScan({ cfg, repo });
  }
  return runFullEval({ cfg, changedFiles, baseSha, headSha, repo, prNumber });
}

// Free path: calls the public site-score-style endpoint, no key needed.
// Returns a preliminary outside-in TrustScore for the declared AI surface.
async function runPreliminaryScan({ cfg, repo }: { cfg: Config; repo: string }): Promise<EvalResult> {
  core.info('No API key — running free preliminary TrustScore scan.');
  // Extract the domain from the repo (e.g. for org-level domains) or use a
  // best-effort org-level scan. In v1 we return a fixed "preliminary" result
  // that links to the console so the user can upgrade.
  const resp = await fetch(`${cfg.baseUrl}/v1/public/site-score/${encodeURIComponent(repo.split('/')[0])}.ai/`);
  if (!resp.ok) {
    return { trustScore: 0, grade: 'F', free: true, reportUrl: 'https://app.trustmodel.ai' };
  }
  const data = await resp.json() as { trust_score?: number; grade?: string };
  return {
    trustScore:  data.trust_score ?? 0,
    grade:       data.grade ?? 'F',
    free:        true,
    reportUrl:   `https://app.trustmodel.ai/register?repo=${encodeURIComponent(repo)}`,
  };
}

// Full path: calls the eval API with the changed file contents.
async function runFullEval({ cfg, changedFiles, baseSha, headSha, repo, prNumber }: RunEvalOptions & { cfg: Config }): Promise<EvalResult> {
  core.info(`Running full TrustModel eval for ${changedFiles.length} changed AI file(s)…`);

  // Collect changed file content (up to 500KB total — eval payload limit).
  const assets: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;
  for (const f of changedFiles) {
    try {
      const content = readFileSync(f, 'utf8');
      totalBytes += content.length;
      if (totalBytes > 500_000) { core.warning(`Payload limit reached — truncating at ${f}`); break; }
      assets.push({ path: f, content });
    } catch { /* deleted file — skip */ }
  }

  const payload = {
    source:       'github_action',
    repo,
    pr_number:    prNumber,
    base_sha:     baseSha,
    head_sha:     headSha,
    changed_assets: assets,
    framework:    cfg.framework,
    cert_on_pass: cfg.certOnPass,
  };

  const resp = await fetch(`${cfg.baseUrl}/v1/evaluations/pr/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key':     cfg.apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`TrustModel eval API returned ${resp.status}: ${text}`);
  }

  const data = await resp.json() as {
    trust_score: number;
    grade: string;
    base_trust_score?: number;
    factor_scores?: Record<string, number>;
    base_factor_scores?: Record<string, number>;
    compliance_gaps?: string[];
    report_url?: string;
    cert_url?: string;
  };

  const dimensionDeltas: DimensionDelta[] = Object.entries(data.factor_scores ?? {}).map(([dim, after]) => {
    const before = data.base_factor_scores?.[dim] ?? null;
    return {
      dimension: dim,
      before,
      after,
      delta: before !== null ? after - before : 0,
      critical: CRITICAL_DIMS.has(dim),
    };
  });

  return {
    trustScore:      data.trust_score,
    grade:           data.grade,
    baseTrustScore:  data.base_trust_score,
    dimensionDeltas,
    complianceGaps:  data.compliance_gaps,
    reportUrl:       data.report_url,
    certUrl:         data.cert_url,
    free:            false,
  };
}
