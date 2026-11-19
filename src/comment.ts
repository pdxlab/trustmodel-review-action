import type { getOctokit } from '@actions/github';
import type { Context } from '@actions/github/lib/context';
import { EvalResult } from './eval';
import { Config } from './config';

type Octokit = ReturnType<typeof getOctokit>;

const GRADE_EMOJI: Record<string, string> = { A: '🟢', B: '🔵', C: '🟡', D: '🟠', F: '🔴' };
const MARKER = '<!-- trustmodel-trust-review -->';

function deltaStr(d: number | null | undefined): string {
  if (d == null || d === 0) return '—';
  if (d <= -10) return `⚠️ ${d > 0 ? '+' : ''}${d}`;
  if (d <   0)  return `↓ ${d}`;
  return `↑ +${d}`;
}

export async function postReviewComment({
  octokit, ctx, prNumber, headSha, result, cfg, sarifEnabled,
}: {
  octokit: Octokit;
  ctx: Context;
  prNumber: number;
  headSha: string;
  result: EvalResult;
  cfg: Config;
  sarifEnabled?: boolean;
}): Promise<void> {
  const passed = result.trustScore >= cfg.threshold;
  const grade  = result.grade ?? '—';
  const emoji  = GRADE_EMOJI[grade] ?? '⚪';
  const base   = result.baseTrustScore;
  const diff   = base != null
    ? ` (${result.trustScore > base ? '↑' : result.trustScore < base ? '↓' : '→'} from ${base})`
    : '';

  const lines: string[] = [MARKER, ''];
  lines.push(`## ${emoji} Trust Review (TR) — TrustScore **${result.trustScore}/100 (${grade})**${diff}`);
  lines.push('');
  lines.push('> **Just as every change needs a PR review, every AI change needs a Trust Review (TR).  ');
  lines.push('> PR → TR → deploy. No passing TR → no deploy.**');
  lines.push('');

  if (result.free) {
    lines.push('> ⏳ **Scoring pending** — no `TRUSTMODEL_API_KEY` detected.');
    lines.push('> This change was recorded and will appear in the TrustModel console,');
    lines.push('> but the 0–100 TrustScore hasn\'t been calculated yet. The status check');
    lines.push('> is set to **pending** (yellow), not failed — it won\'t block your merge.');
    lines.push('>');
    lines.push('> Add `TRUSTMODEL_API_KEY` to your repo secrets for the full scored evaluation:');
    lines.push('> per-dimension diff, compliance mapping, critical-dimension regression blocking.');
    lines.push('>');
    lines.push('> [Get API key →](https://app.trustmodel.ai/keys)  &nbsp;  [Learn more →](https://trustmodel.ai/trust-review-action)');
    lines.push('');
  } else if (result.dimensionDeltas && result.dimensionDeltas.length > 0) {
    lines.push('| Dimension | Before | After | Change |');
    lines.push('|---|---|---|---|');
    const sorted = [...result.dimensionDeltas].sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0));
    for (const d of sorted) {
      const crit   = d.critical ? '⭐ ' : '';
      const before = d.before != null ? String(d.before) : '—';
      const after  = d.after  != null ? String(d.after)  : '—';
      lines.push(`| ${crit}${d.label} | ${before} | ${after} | ${deltaStr(d.delta)} |`);
    }
    lines.push('');
    lines.push('> ⭐ Critical dimension — a drop of >10 points blocks the TR even if the overall score passes.');
    lines.push('');
  }

  // Warnings.
  const regressions = (result.dimensionDeltas ?? []).filter(d => d.critical && (d.delta ?? 0) < -10);
  if (regressions.length) {
    const names = regressions.map(d => d.label).join(', ');
    lines.push(`> ⚠️ **${names} dropped sharply. Review before merging.**`);
    lines.push('');
  }

  if (passed && !regressions.length) {
    lines.push(`> ✅ **TR passed** — score ${result.trustScore} ≥ threshold ${cfg.threshold}.`);
  } else if (!passed) {
    lines.push(`> 🚫 **TR failed** — score ${result.trustScore} is below threshold (${cfg.threshold}). **Deploy blocked.**`);
  }
  lines.push('');

  if (result.complianceGaps?.length) {
    lines.push(`**Compliance gaps (${cfg.framework ?? 'framework'}):** ${result.complianceGaps.slice(0, 5).join(', ')}`);
    lines.push('');
  }

  // Deeplinks.
  const links: string[] = [];
  if (result.reportUrl) links.push(`[📊 Full report →](${result.reportUrl})`);
  if (result.certUrl)   links.push(`[🏅 AgentCert →](${result.certUrl})`);
  links.push('[🔍 TrustModel console →](https://app.trustmodel.ai)');
  lines.push(links.join('  &nbsp;·&nbsp;  '));
  lines.push('');
  if (sarifEnabled) {
    lines.push('📋 Findings also uploaded to [Code Scanning](../../security/code-scanning).');
    lines.push('');
  }
  lines.push('---');
  lines.push('*[AI Trust Reviewer](https://github.com/pdxlab/trustmodel-review-action) — the Trust Review for every AI PR. The `trustmodel/trust-review` check must be green before deploy.*');

  const body = lines.join('\n');

  // Upsert: find our marker comment and update it, or create new.
  const existing = await findExistingComment(octokit, ctx, prNumber);
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: ctx.repo.owner, repo: ctx.repo.repo,
      comment_id: existing, body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner: ctx.repo.owner, repo: ctx.repo.repo,
      issue_number: prNumber, body,
    });
  }
}

async function findExistingComment(octokit: Octokit, ctx: Context, prNumber: number): Promise<number | null> {
  for await (const page of octokit.paginate.iterator(
    octokit.rest.issues.listComments,
    { owner: ctx.repo.owner, repo: ctx.repo.repo, issue_number: prNumber, per_page: 100 }
  )) {
    for (const c of page.data) {
      if (c.body?.includes(MARKER)) return c.id;
    }
  }
  return null;
}
