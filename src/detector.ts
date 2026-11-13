import { execFileSync } from 'child_process';
import { minimatch } from 'minimatch';

export const DEFAULT_PATTERNS = [
  '**/*.prompt', '**/*.prompt.txt', '**/*.jinja', '**/*.jinja2', '**/prompts/**',
  '**/system_prompt*', '**/model_config*', '**/model-config*', '**/llm_config*',
  '**/ai_config*', '**/evals/**', '**/evaluations/**', '**/agents/**',
  '**/*agent*.py', '**/*agent*.ts', '**/*agent*.js', '**/chains/**', '**/tools/**',
  '.trustmodel.yml', 'trustmodel.config.*',
];

export interface DetectOptions { baseSha: string; headSha: string; patterns: string[] }
export async function detectAiChanges({ baseSha, headSha, patterns }: DetectOptions): Promise<string[]> {
  if (![baseSha, headSha].every(sha => /^[a-fA-F0-9]{40}$/.test(sha))) throw new Error('Expected real commit SHAs.');
  const active = patterns.length ? patterns : DEFAULT_PATTERNS;
  // No source file reads, shell interpolation, or fallback to a different diff.
  // --no-renames exposes both old and new paths when a policy file is moved.
  const output = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', `${baseSha}...${headSha}`],
                              { encoding: 'utf8', maxBuffer: 2_000_000 });
  const files = [...new Set(output.split('\0').filter(Boolean))];
  if (files.length > 3000) throw new Error('Too many changed files for a complete metadata receipt.');
  return files.filter(f => active.some(p => minimatch(f, p, { matchBase: true })));
}
