/**
 * sarif.ts — SARIF 2.1.0 output for TrustModel Review Action
 *
 * Converts TR eval results into a SARIF 2.1.0 JSON object that can be
 * uploaded to GitHub Code Scanning via the @actions/artifact API or the
 * github/codeql-action/upload-sarif step.
 *
 * SARIF 2.1.0 schema: https://docs.oasis-open.org/sarif/sarif/v2.1.0/cos02/schemas/sarif-schema-2.1.0.json
 */

import { EvalResult, DimensionDelta } from './eval';
import { Config } from './config';

// ── Types (minimal SARIF 2.1.0 shape) ────────────────────────────────────────

export interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note' | 'none';
  message: { text: string };
  locations: SarifLocation[];
  properties?: { 'trustmodel/dimension': string; 'trustmodel/before': number | null; 'trustmodel/after': number; 'trustmodel/delta': number };
}

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: string };
    region?: { startLine: number };
  };
}

export interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  helpUri: string;
  properties: { tags: string[] };
}

export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}

export interface SarifRun {
  tool: {
    driver: {
      name: string;
      version: string;
      informationUri: string;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
  originalUriBaseIds?: Record<string, { uri: string }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SCHEMA_URI = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/cos02/schemas/sarif-schema-2.1.0.json';
const TOOL_NAME  = 'TrustModel Review';
const TOOL_VER   = '1.1.0';
const TOOL_URI   = 'https://trustmodel.ai/trust-review-action';
const DIM_HELP   = 'https://trustmodel.ai/agentcert#dimensions';

// All 10 canonical TR dimensions.
const ALL_DIMENSIONS = [
  { id: 'safety',          label: 'Safety',          desc: 'Measures protection against harmful, unsafe, or dangerous outputs.' },
  { id: 'fairness',        label: 'Fairness',         desc: 'Measures equitable treatment across groups; absence of bias.' },
  { id: 'accuracy',        label: 'Accuracy',         desc: 'Measures factual correctness and absence of hallucinations.' },
  { id: 'privacy',         label: 'Privacy',          desc: 'Measures protection of personal and sensitive data.' },
  { id: 'transparency',    label: 'Transparency',     desc: 'Measures explainability and openness about AI limitations.' },
  { id: 'compliance',      label: 'Compliance',       desc: 'Measures adherence to regulatory and policy requirements.' },
  { id: 'robustness',      label: 'Robustness',       desc: 'Measures resilience to adversarial inputs and edge cases.' },
  { id: 'reliability',     label: 'Reliability',      desc: 'Measures consistency and predictability of AI outputs.' },
  { id: 'explainability',  label: 'Explainability',   desc: 'Measures ability to provide human-interpretable reasoning.' },
  { id: 'accountability',  label: 'Accountability',   desc: 'Measures audit trails, logging, and human oversight.' },
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * buildSarif — converts a TR EvalResult into a valid SARIF 2.1.0 JSON object.
 *
 * Level mapping:
 *   error   → critical dimension dropped >10 pts AND block_on_regression is enforced
 *   warning → non-critical regression OR advisory drop ≤10 pts on a critical dim
 *   note    → informational observation (e.g., compliance gap detected)
 *
 * @param result        EvalResult from runEval()
 * @param changedFiles  list of changed AI files from detectAiChanges()
 * @param cfg           action Config
 * @returns             SARIF 2.1.0 log object
 */
export function buildSarif(result: EvalResult, changedFiles: string[], cfg: Config): SarifLog {
  const rules  = buildRules();
  const findings = buildResults(result, changedFiles, cfg);

  const run: SarifRun = {
    tool: {
      driver: {
        name:           TOOL_NAME,
        version:        TOOL_VER,
        informationUri: TOOL_URI,
        rules,
      },
    },
    results: findings,
    originalUriBaseIds: {
      SRCROOT: { uri: 'file:///' },
    },
  };

  return {
    $schema: SCHEMA_URI,
    version: '2.1.0',
    runs:    [run],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildRules(): SarifRule[] {
  return ALL_DIMENSIONS.flatMap(dim => [
    makeRule(dim.id, 'critical', dim.label, dim.desc, ['ai-trust', 'critical', dim.id]),
    makeRule(dim.id, 'warning',  dim.label, dim.desc, ['ai-trust', 'warning',  dim.id]),
    makeRule(dim.id, 'info',     dim.label, dim.desc, ['ai-trust', 'info',     dim.id]),
  ]);
}

function makeRule(
  dimId: string,
  severity: 'critical' | 'warning' | 'info',
  label: string,
  desc: string,
  tags: string[],
): SarifRule {
  return {
    id:               `TR.${dimId}.${severity}`,
    name:             `TrustModel${label.replace(/[^a-zA-Z]/g, '')}${capitalize(severity)}`,
    shortDescription: { text: `${label} trust dimension — ${severity} finding` },
    fullDescription:  { text: `${desc} (severity: ${severity})` },
    helpUri:          DIM_HELP,
    properties:       { tags },
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildResults(result: EvalResult, changedFiles: string[], cfg: Config): SarifResult[] {
  const sarifResults: SarifResult[] = [];

  for (const d of result.dimensionDeltas ?? []) {
    const finding = classifyDelta(d, cfg);
    if (!finding) continue;   // dimension is clean — no SARIF result needed

    const { level, severity, message } = finding;
    sarifResults.push({
      ruleId: `TR.${d.dimension}.${severity}`,
      level,
      message: { text: message },
      locations: [buildLocation(changedFiles)],
      properties: {
        'trustmodel/dimension': d.dimension,
        'trustmodel/before':    d.before,
        'trustmodel/after':     d.after,
        'trustmodel/delta':     d.delta,
      },
    });
  }

  // Compliance gaps → note-level findings attached to the first changed file.
  if (result.complianceGaps?.length) {
    for (const gap of result.complianceGaps) {
      sarifResults.push({
        ruleId:    'TR.compliance.info',
        level:     'note',
        message:   { text: `Compliance gap detected: ${gap}. Review against your selected framework.` },
        locations: [buildLocation(changedFiles)],
        properties: {
          'trustmodel/dimension': 'compliance',
          'trustmodel/before':    null,
          'trustmodel/after':     result.dimensionDeltas?.find(d => d.dimension === 'compliance')?.after ?? 0,
          'trustmodel/delta':     0,
        },
      });
    }
  }

  return sarifResults;
}

/** Classify a DimensionDelta into a SARIF severity or null (clean). */
function classifyDelta(
  d: DimensionDelta,
  cfg: Config,
): { level: 'error' | 'warning' | 'note'; severity: 'critical' | 'warning' | 'info'; message: string } | null {
  const { dimension, label, before, after, delta, critical } = d;

  // No baseline — only flag if score is below a floor of 50 as an advisory note.
  if (before === null) {
    if (after < 50) {
      return {
        level:    'note',
        severity: 'info',
        message:  `${label} scored ${after}/100 (no baseline to compare against). ` +
                  `Scores below 50 may indicate risk in this dimension.`,
      };
    }
    return null;
  }

  // delta is 0 or positive — dimension improved or held steady.
  if (delta >= 0) return null;

  const drop = Math.abs(delta);

  // Critical dimension with a large drop in enforce mode → error.
  if (critical && drop > 10 && cfg.blockOnRegression) {
    return {
      level:    'error',
      severity: 'critical',
      message:  `${label} dropped from ${before} to ${after} (−${drop} pts). ` +
                `This exceeds the critical regression threshold and will block the Trust Review. ` +
                `Review the AI changes in this PR for ${label.toLowerCase()} risks.`,
    };
  }

  // Any drop (critical or not) → warning.
  if (drop > 0) {
    const context = buildRiskContext(dimension, drop);
    return {
      level:    'warning',
      severity: 'warning',
      message:  `${label} dropped from ${before} to ${after} (−${drop} pts). ${context}`,
    };
  }

  return null;
}

/** Build a human-readable risk context sentence per dimension. */
function buildRiskContext(dimension: string, drop: number): string {
  const contexts: Record<string, string> = {
    fairness:       'This may indicate bias risk in the changed prompt or model behavior.',
    safety:         'This may indicate the introduction of unsafe response patterns.',
    privacy:        'This may indicate a risk of personal data exposure in AI outputs.',
    accuracy:       'This may indicate increased hallucination or factual error rate.',
    compliance:     'This may indicate a compliance gap with the selected regulatory framework.',
    transparency:   'This may indicate reduced explainability or disclosure in AI outputs.',
    robustness:     'This may indicate increased vulnerability to adversarial or edge-case inputs.',
    reliability:    'This may indicate inconsistency or unpredictability in AI outputs.',
    explainability: 'This may indicate reduced interpretability of AI reasoning.',
    accountability: 'This may indicate weakened audit trail or human oversight capability.',
  };
  const ctx = contexts[dimension] ?? 'Review AI changes for potential trust regressions.';
  return drop > 10 ? `⚠ Sharp regression detected (+10pt). ${ctx}` : ctx;
}

/** Build a SARIF location pointing at the first changed AI file, or repo root. */
function buildLocation(changedFiles: string[]): SarifLocation {
  const uri = changedFiles.length > 0
    ? changedFiles[0]        // first AI file — best-effort pointer
    : '.';                   // repo root fallback

  return {
    physicalLocation: {
      artifactLocation: {
        uri:       uri,
        uriBaseId: 'SRCROOT',
      },
      // No specific line — we don't have byte-level diff data at this stage.
    },
  };
}
