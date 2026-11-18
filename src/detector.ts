import * as core from '@actions/core';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { minimatch } from 'minimatch';

// Epic 5: Path-based defaults + content sniffing so broad name globs (e.g.
// **/*agent*.py) don't match unrelated files like user_agent.py.
// A file matched only by name glob must also import an LLM SDK or contain
// a prompt-like string literal (>200 chars with assistant-style tokens).

const PATH_PATTERNS = [
  // Explicit path-based matches (high confidence, no content check needed)
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
  '**/chains/**',
  '.trustmodel.yml',
  '.trustreview.yml',
  'trustmodel.config.*',
];

// Name-only globs that require content sniffing before matching
const NAME_GLOBS_NEED_SNIFF = [
  '**/*agent*.py',
  '**/*agent*.ts',
  '**/*agent*.js',
  '**/tools/**/*.py',
  '**/tools/**/*.ts',
];

// Excluded paths — always skip regardless of patterns
const ALWAYS_EXCLUDE = [
  '**/test*/**/fixtures/**',
  '**/__fixtures__/**',
  '**/*.lock',
  '**/node_modules/**',
  '**/vendor/**',
  '**/.venv/**',
  '**/dist/**',
];

// LLM SDK import markers (content sniff)
const LLM_SDK_RE = /(?:openai|anthropic|langchain|llama_index|@ai-sdk\/|litellm|crewai|autogen|google\.generativeai|mistralai|transformers|huggingface|cohere|@google\/generative-ai)/i;
// Prompt-like string literal: long string with AI instruction tokens
const PROMPT_LITERAL_RE = /["'`](?:[^"'`]{200,}(?:you are|system:|<\|im_start\||<\|system\||assistant:|user:)[^"'`]{0,2000})["'`]/i;

function needsContentSniff(filePath: string): boolean {
  return NAME_GLOBS_NEED_SNIFF.some(p => minimatch(filePath, p, { matchBase: true }));
}

function isExcluded(filePath: string): boolean {
  return ALWAYS_EXCLUDE.some(p => minimatch(filePath, p, { matchBase: true }));
}

function sniffHasLlmContent(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf8').slice(0, 50_000);
    return LLM_SDK_RE.test(content) || PROMPT_LITERAL_RE.test(content);
  } catch {
    return false; // can't read → don't match
  }
}

export interface DetectOptions {
  baseSha: string;
  headSha: string;
  patterns: string[];  // empty = use defaults
  debug: boolean;
}

export async function detectAiChanges({ baseSha, headSha, patterns, debug }: DetectOptions): Promise<string[]> {
  const useCustom = patterns.length > 0;
  const pathPatterns  = useCustom ? patterns : PATH_PATTERNS;
  const nameGlobs     = useCustom ? [] : NAME_GLOBS_NEED_SNIFF;

  let diffOutput: string;
  try {
    diffOutput = execSync(
      `git diff --name-only ${baseSha}..${headSha}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch {
    diffOutput = execSync(`git diff --name-only HEAD^1..HEAD`, { encoding: 'utf8' });
  }

  const files = diffOutput.split('\n').map(f => f.trim()).filter(Boolean);
  const matched: string[] = [];

  for (const f of files) {
    if (isExcluded(f)) {
      if (debug) core.info(`[TR detect] SKIP (excluded):  ${f}`);
      continue;
    }

    // 1. Path-pattern match (high confidence, no sniff needed)
    if (pathPatterns.some(p => minimatch(f, p, { matchBase: true }))) {
      if (debug) core.info(`[TR detect] MATCH (path):      ${f}`);
      matched.push(f);
      continue;
    }

    // 2. Name-glob match — requires content sniff
    if (nameGlobs.some(p => minimatch(f, p, { matchBase: true }))) {
      const hasLlm = existsSync(f) && sniffHasLlmContent(f);
      if (hasLlm) {
        if (debug) core.info(`[TR detect] MATCH (name+sniff): ${f}`);
        matched.push(f);
      } else {
        if (debug) core.info(`[TR detect] SKIP (name, no LLM): ${f}`);
      }
    }
  }

  return matched;
}
