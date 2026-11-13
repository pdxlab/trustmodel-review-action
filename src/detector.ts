import { execSync } from 'child_process';
import { minimatch } from 'minimatch';

// Built-in patterns that signal AI-related files. Configurable via .trustmodel.yml
// or the action's detect input.
const DEFAULT_PATTERNS = [
  '**/*.prompt',
  '**/*.prompt.txt',
  '**/*.jinja',
  '**/*.jinja2',
  '**/prompts/**',
  '**/system_prompt*',
  '**/model_config*',
  '**/model-config*',
  '**/llm_config*',
  '**/ai_config*',
  '**/evals/**',
  '**/evaluations/**',
  '**/agents/**',
  '**/*agent*.py',
  '**/*agent*.ts',
  '**/*agent*.js',
  '**/chains/**',
  '**/tools/**',
  '.trustmodel.yml',
  'trustmodel.config.*',
];

export interface DetectOptions {
  baseSha: string;
  headSha: string;
  patterns: string[];  // empty = use defaults
}

export async function detectAiChanges({ baseSha, headSha, patterns }: DetectOptions): Promise<string[]> {
  const active = patterns.length > 0 ? patterns : DEFAULT_PATTERNS;

  // Use git diff to list changed files between base and head.
  let diffOutput: string;
  try {
    diffOutput = execSync(
      `git diff --name-only ${baseSha}..${headSha}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch {
    // Fall back to comparing against HEAD^ if the two SHAs aren't both present.
    diffOutput = execSync(`git diff --name-only HEAD^1..HEAD`, { encoding: 'utf8' });
  }

  const files = diffOutput.split('\n').map(f => f.trim()).filter(Boolean);
  return files.filter(f => active.some(pat => minimatch(f, pat, { matchBase: true })));
}
