import { execFileSync } from 'child_process';
import { minimatch } from 'minimatch';

export const DEFAULT_PATTERNS = [
  '**/*.prompt', '**/*.prompt.txt', '**/*.jinja', '**/*.jinja2', '**/prompts/**',
  '**/system_prompt*', '**/model_config*', '**/model-config*', '**/llm_config*',
  '**/ai_config*', '**/evals/**', '**/evaluations/**', '**/agents/**',
  '**/*agent*.py', '**/*agent*.ts', '**/*agent*.js', '**/chains/**',
  // Source files only: a tools/ directory also holds build scripts, binaries and data.
  '**/tools/**/*.py', '**/tools/**/*.ts', '**/tools/**/*.js',
  '.trustmodel.yml', 'trustmodel.config.*',
];

// TRUS-2595: known false positives of the default globs, decided from the path
// alone (source content is never read). Applied to the defaults only: a custom
// `detect` list means exactly what it says. Kept narrow on purpose, because an
// excluded path turns a PR into a green "skipped" status.
export const DEFAULT_EXCLUDES = [
  // HTTP user agents, not AI agents: user_agent.py, user-agent.ts, UserAgent.ts, useragent_parser.js
  '**/*user[_-]agent*', '**/*useragent*',
  // Dependencies and build output, never the repository's own AI code.
  '**/node_modules/**', '**/vendor/**', '**/.venv/**', '**/venv/**', '**/site-packages/**', '**/dist/**',
];

export function matchesDetection(file: string, patterns: string[]): boolean {
  if (patterns.length) return patterns.some(p => minimatch(file, p, { matchBase: true }));
  return DEFAULT_PATTERNS.some(p => minimatch(file, p, { matchBase: true }))
    && !DEFAULT_EXCLUDES.some(p => minimatch(file, p, { matchBase: true, nocase: true, dot: true }));
}

export interface DetectOptions { baseSha: string; headSha: string; patterns: string[] }

// TRUS-2642: AI code in an ordinary-looking file (src/services/openai_client.py)
// matches no path rule. For changed source files the path rules missed, read the
// file at the PR head on this runner and look for an AI SDK import. The content
// never leaves the runner: only the path is sent, as import_matched_files.
export const IMPORT_SOURCE = /\.(py|js|jsx|ts|tsx|mjs|cjs)$/;
export const MAX_IMPORT_CANDIDATES = 300;
export const MAX_IMPORT_FILE_BYTES = 256 * 1024;
// Import statements only (line-anchored for Python), so an SDK named in a comment
// or a string is not a match. `langchain\w*` covers langchain_core, _openai, ...
const PY_AI_IMPORT = /^[ \t]*(?:from|import)[ \t]+(?:openai|anthropic|langchain\w*|langgraph|llama_index|litellm|google\.generativeai|google\.genai|mistralai|cohere|groq|ollama|azure\.ai\.inference|azure\.ai\.openai)\b/m;
const JS_AI_IMPORT = /(?:\bfrom|\brequire\(|\bimport\(?)[ \t]*['"](?:openai|@anthropic-ai\/sdk|langchain|@langchain\/[\w.-]+|llamaindex|@google\/generative-ai|@google\/genai|@mistralai\/mistralai|cohere-ai|groq-sdk|ollama|ai|@ai-sdk\/[\w.-]+|@azure\/openai|@azure-rest\/ai-inference|@aws-sdk\/client-bedrock-runtime)(?:\/[\w./-]*)?['"]/;
// boto3.client("bedrock-runtime") has no SDK-specific import.
const BEDROCK_CLIENT = /['"]bedrock-runtime['"]/;

export function hasAiImport(file: string, text: string): boolean {
  return (file.endsWith('.py') ? PY_AI_IMPORT : JS_AI_IMPORT).test(text) || BEDROCK_CLIENT.test(text);
}

export function isImportCandidate(file: string): boolean {
  return IMPORT_SOURCE.test(file)
    && !DEFAULT_EXCLUDES.some(p => minimatch(file, p, { matchBase: true, nocase: true, dot: true }));
}

function changedFiles(baseSha: string, headSha: string): string[] {
  if (![baseSha, headSha].every(sha => /^[a-fA-F0-9]{40}$/.test(sha))) throw new Error('Expected real commit SHAs.');
  // No shell interpolation or fallback to a different diff.
  // --no-renames exposes both old and new paths when a policy file is moved.
  const output = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', `${baseSha}...${headSha}`],
                              { encoding: 'utf8', maxBuffer: 2_000_000 });
  const files = [...new Set(output.split('\0').filter(Boolean))];
  if (files.length > 3000) throw new Error('Too many changed files for a complete metadata receipt.');
  return files;
}

// {path: text} of each path that is a text blob of at most MAX_IMPORT_FILE_BYTES
// at headSha. Deleted, oversized and binary files are left out. Two git calls in
// total (sizes, then contents), never a shell.
function readHeadBlobs(headSha: string, paths: string[]): Map<string, string> {
  const named = paths.filter(p => !p.includes('\n'));
  const out = new Map<string, string>();
  if (!named.length) return out;
  const checks = execFileSync('git', ['cat-file', '--batch-check'],
    { input: named.map(p => `${headSha}:${p}\n`).join(''), encoding: 'utf8', maxBuffer: 2_000_000 }).split('\n');
  const small = named.filter((_, i) => {
    const m = /^[0-9a-f]{40,64} blob (\d+)$/.exec(checks[i] ?? '');
    return !!m && Number(m[1]) <= MAX_IMPORT_FILE_BYTES;
  });
  if (!small.length) return out;
  const raw = execFileSync('git', ['cat-file', '--batch'],
    { input: small.map(p => `${headSha}:${p}\n`).join(''), maxBuffer: small.length * (MAX_IMPORT_FILE_BYTES + 200) });
  let at = 0;
  for (const path of small) {
    const eol = raw.indexOf(10, at);
    if (eol < 0) break;
    const m = /^[0-9a-f]{40,64} blob (\d+)$/.exec(raw.subarray(at, eol).toString('utf8'));
    if (!m) break;
    const body = raw.subarray(eol + 1, eol + 1 + Number(m[1]));
    at = eol + 1 + Number(m[1]) + 1;
    if (!body.includes(0)) out.set(path, body.toString('utf8'));
  }
  return out;
}

export interface AiChangeSet { pathMatched: string[]; importMatched: string[] }
export async function detectAiChangeSet({ baseSha, headSha, patterns }: DetectOptions): Promise<AiChangeSet> {
  const files = changedFiles(baseSha, headSha);
  const pathMatched = files.filter(f => matchesDetection(f, patterns));
  // A custom `detect` list means exactly what it says: no import scan.
  if (patterns.length) return { pathMatched, importMatched: [] };
  const matched = new Set(pathMatched);
  const candidates = files.filter(f => !matched.has(f) && isImportCandidate(f)).slice(0, MAX_IMPORT_CANDIDATES);
  let blobs = new Map<string, string>();
  try {
    blobs = readHeadBlobs(headSha, candidates);
  } catch {
    // A missing object (shallow clone) or git error: fall back to path rules only.
  }
  return { pathMatched, importMatched: candidates.filter(f => blobs.has(f) && hasAiImport(f, blobs.get(f)!)) };
}

// Path rules only; source content is never read.
export async function detectAiChanges({ baseSha, headSha, patterns }: DetectOptions): Promise<string[]> {
  return changedFiles(baseSha, headSha).filter(f => matchesDetection(f, patterns));
}
