import type { getOctokit } from '@actions/github';
import type { Context } from '@actions/github/lib/context';
import { EvalResult } from './eval';
import { Config } from './config';

type Octokit = ReturnType<typeof getOctokit>;

const GRADE_EMOJI: Record<string, string> = { A: '🟢', B: '🔵', C: '🟡', D: '🟠', F: '🔴' };
const DIM_LABEL: Record<string, string> = {
  safety: 'Safety', fairness: 'Fairness', privacy: 'Privacy', accuracy: 'Accuracy',
  transparency: 'Transparency', compliance: 'Compliance', robustness: 'Robustness',
  reliability: 'Reliability', explainability: 'Explainability', accountability: 'Accountability',
  robustness_security: 'Robustness / Security', data_privacy: 'Data Privacy',
  model_safety: 'Model Safety', ai_governance: 'AI Governance',
};

function dim(key: string): string { return DIM_LABEL[key] ?? key; }
function delta(d: number): string {
  if (d === 0) return '—';
  const s = d > 0 ? `+${d}` : String(d);
  return d <= -10 ? `⚠️ ${s}` : d < 0 ? `↓ ${s}` : `↑ ${s}`;
}

export async function postReviewComment({
  octokit, ctx, pr, result, cfg,
}: {
  octokit: Octokit;
  ctx: Context;
  pr: { number: number; head: { sha: string } };
  result: EvalResult;
  cfg: Config;
}): Promise<void> {
  const passed = result.trustScore >= cfg.threshold;
  const grade = result.grade ?? '—';
  const emoji = GRADE_EMOJI[grade] ?? '⚪';
  const diff = result.baseTrustScore !== undefined
    ? ` (${result.trustScore > result.baseTrustScore ? '↑' : result.trustScore < result.baseTrustScore ? '↓' : '→'} from ${result.baseTrustScore})`
    : '';

  let body = `## ${emoji} TrustModel Review — TrustScore **${result.trustScore}/100 (${grade})**${diff}\n\n`;

  if (result.free) {
    body += `> **Free preliminary scan.** Add a \`TRUSTMODEL_API_KEY\` secret to get the full 10-dimension breakdown, compliance mapping, and optional AgentCert.\n>\n> [Upgrade →](https://app.trustmodel.ai/register)\n\n`;
  } else if (result.dimensionDeltas && result.dimensionDeltas.length > 0) {
    body += `| Dimension | Before | After | Change |\n|---|---|---|---|\n`;
    const sorted = [...result.dimensionDeltas].sort((a, b) => a.delta - b.delta);
    for (const d of sorted) {
      body += `| ${d.critical ? '⭐ ' : ''}${dim(d.dimension)} | ${d.before ?? '—'} | ${d.after} | ${delta(d.delta)} |\n`;
    }
    body += `\n> ⭐ Critical dimension (Safety / Fairness / Privacy / Compliance)\n\n`;
  }

  // Warnings
  const regressions = result.dimensionDeltas?.filter(d => d.critical && d.delta < -10) ?? [];
  if (regressions.length > 0) {
    body += `> ⚠️ **${regressions.map(d => dim(d.dimension)).join(', ')} dropped sharply.** Review before merging.\n\n`;
  }
  if (!passed) {
    body += `> 🚫 **Score ${result.trustScore} is below the threshold (${cfg.threshold}).** This check will block merge.\n\n`;
  } else if (regressions.length === 0) {
    body += `> ✅ Gate passed — score ${result.trustScore} ≥ threshold ${cfg.threshold}.\n\n`;
  }

  // Compliance gaps
  if (result.complianceGaps && result.complianceGaps.length > 0) {
    body += `**Compliance gaps** (${cfg.framework ?? 'framework'}):\n`;
    for (const gap of result.complianceGaps.slice(0, 5)) body += `- ${gap}\n`;
    body += '\n';
  }

  // Links
  const links: string[] = [];
  if (result.reportUrl) links.push(`[📊 Full report →](${result.reportUrl})`);
  if (result.certUrl)   links.push(`[🏅 AgentCert →](${result.certUrl})`);
  links.push(`[🔍 TrustModel console →](https://app.trustmodel.ai)`);
  body += links.join('  ·  ') + '\n\n';
  body += `---\n*[TrustModel Review Action](https://github.com/pdxlab/trustmodel-review-action) — the AI trust gate for your CI/CD*`;

  // Find and update an existing bot comment, or create a new one.
  const MARKER = '<!-- trustmodel-review -->';
  const comments = await octokit.rest.issues.listComments({
    owner: ctx.repo.owner, repo: ctx.repo.repo, issue_number: pr.number,
  });
  const existing = comments.data.find(c => c.body?.includes(MARKER));

  const fullBody = MARKER + '\n' + body;
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: ctx.repo.owner, repo: ctx.repo.repo,
      comment_id: existing.id, body: fullBody,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner: ctx.repo.owner, repo: ctx.repo.repo,
      issue_number: pr.number, body: fullBody,
    });
  }
}
