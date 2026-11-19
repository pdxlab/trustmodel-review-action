/**
 * sarif.test.ts — unit tests for buildSarif()
 *
 * Scenarios:
 *  1. Builds valid SARIF 2.1.0 structure (required fields present)
 *  2. Critical dimension drop >10 pts + blockOnRegression → error level
 *  3. Advisory regression (non-critical or ≤10 pt drop) → warning level
 *  4. Clean pass (all deltas ≥ 0) → empty results array
 *  5. No baseline available + score < 50 → note level
 *  6. No baseline + score ≥ 50 → no result (clean)
 *  7. Compliance gaps → note-level compliance results
 *  8. No changed files → location falls back to repo root '.'
 */

import { buildSarif, SarifLog } from '../sarif';
import { EvalResult, DimensionDelta } from '../eval';
import { Config } from '../config';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_CFG: Config = {
  apiKey: 'tm-test',
  threshold: 65,
  blockOnRegression: true,
  certOnPass: false,
  detectPatterns: [],
  baseUrl: 'https://api.trustmodel.ai',
};

const BASE_RESULT: EvalResult = {
  trustScore: 80,
  grade: 'B',
  baseTrustScore: 82,
  dimensionDeltas: [],
  free: false,
};

function makeDelta(overrides: Partial<DimensionDelta>): DimensionDelta {
  return {
    dimension: 'fairness',
    label:     'Fairness',
    before:    80,
    after:     71,
    delta:     -9,
    critical:  true,
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function assertValidSarifStructure(sarif: SarifLog): void {
  // $schema
  expect(sarif.$schema).toContain('sarif-schema-2.1.0');
  // version
  expect(sarif.version).toBe('2.1.0');
  // runs array
  expect(Array.isArray(sarif.runs)).toBe(true);
  expect(sarif.runs.length).toBeGreaterThanOrEqual(1);

  const run = sarif.runs[0];
  // tool.driver
  expect(run.tool).toBeDefined();
  expect(run.tool.driver).toBeDefined();
  expect(run.tool.driver.name).toBe('TrustModel Review');
  expect(run.tool.driver.version).toBe('1.1.0');
  expect(run.tool.driver.informationUri).toBe('https://trustmodel.ai/trust-review-action');
  expect(Array.isArray(run.tool.driver.rules)).toBe(true);
  expect(run.tool.driver.rules.length).toBeGreaterThan(0);

  // results array must exist
  expect(Array.isArray(run.results)).toBe(true);

  // Every rule must have required fields
  for (const rule of run.tool.driver.rules) {
    expect(typeof rule.id).toBe('string');
    expect(rule.id).toMatch(/^TR\.\w+\.(critical|warning|info)$/);
    expect(rule.helpUri).toBe('https://trustmodel.ai/agentcert#dimensions');
    expect(rule.shortDescription?.text).toBeTruthy();
    expect(rule.fullDescription?.text).toBeTruthy();
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildSarif — SARIF 2.1.0 structure', () => {
  test('1. produces valid SARIF 2.1.0 structure with required fields', () => {
    const sarif = buildSarif(BASE_RESULT, ['prompts/system.txt'], BASE_CFG);
    assertValidSarifStructure(sarif);
  });

  test('1b. empty results array when no dimension deltas', () => {
    const sarif = buildSarif({ ...BASE_RESULT, dimensionDeltas: [] }, ['prompts/system.txt'], BASE_CFG);
    expect(sarif.runs[0].results).toHaveLength(0);
  });
});

describe('buildSarif — critical dimension drop', () => {
  test('2a. critical dim drop >10 pts + blockOnRegression=true → error level', () => {
    const result: EvalResult = {
      ...BASE_RESULT,
      dimensionDeltas: [
        makeDelta({ dimension: 'safety', label: 'Safety', before: 90, after: 72, delta: -18, critical: true }),
      ],
    };
    const sarif = buildSarif(result, ['agents/chat_agent.py'], BASE_CFG);
    const findings = sarif.runs[0].results;
    expect(findings).toHaveLength(1);
    expect(findings[0].level).toBe('error');
    expect(findings[0].ruleId).toBe('TR.safety.critical');
    expect(findings[0].message.text).toContain('−18 pts');
    expect(findings[0].message.text).toContain('block the Trust Review');
  });

  test('2b. critical dim drop >10 pts + blockOnRegression=false → warning (not error)', () => {
    const cfg = { ...BASE_CFG, blockOnRegression: false };
    const result: EvalResult = {
      ...BASE_RESULT,
      dimensionDeltas: [
        makeDelta({ dimension: 'fairness', label: 'Fairness', before: 85, after: 70, delta: -15, critical: true }),
      ],
    };
    const sarif = buildSarif(result, ['prompts/hr_screen.prompt'], cfg);
    const findings = sarif.runs[0].results;
    expect(findings).toHaveLength(1);
    // Not an error because blocking is off
    expect(findings[0].level).toBe('warning');
    expect(findings[0].ruleId).toBe('TR.fairness.warning');
  });

  test('2c. multiple critical regressions → one error result each', () => {
    const result: EvalResult = {
      ...BASE_RESULT,
      dimensionDeltas: [
        makeDelta({ dimension: 'safety',    label: 'Safety',    before: 88, after: 72, delta: -16, critical: true }),
        makeDelta({ dimension: 'fairness',  label: 'Fairness',  before: 80, after: 65, delta: -15, critical: true }),
        makeDelta({ dimension: 'privacy',   label: 'Privacy',   before: 90, after: 85, delta:  -5, critical: true }),
      ],
    };
    const sarif = buildSarif(result, ['agents/main.ts'], BASE_CFG);
    const findings = sarif.runs[0].results;
    // safety + fairness → error; privacy drop ≤10 → warning
    const errors   = findings.filter(f => f.level === 'error');
    const warnings = findings.filter(f => f.level === 'warning');
    expect(errors).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(errors.map(e => e.ruleId).sort()).toEqual(['TR.fairness.critical', 'TR.safety.critical']);
  });
});

describe('buildSarif — advisory regression (warning)', () => {
  test('3a. non-critical dimension with any drop → warning level', () => {
    const result: EvalResult = {
      ...BASE_RESULT,
      dimensionDeltas: [
        makeDelta({ dimension: 'accuracy', label: 'Accuracy', before: 75, after: 68, delta: -7, critical: false }),
      ],
    };
    const sarif = buildSarif(result, ['evals/accuracy_check.py'], BASE_CFG);
    const findings = sarif.runs[0].results;
    expect(findings).toHaveLength(1);
    expect(findings[0].level).toBe('warning');
    expect(findings[0].ruleId).toBe('TR.accuracy.warning');
    expect(findings[0].message.text).toContain('−7 pts');
    expect(findings[0].message.text).toContain('hallucination');
  });

  test('3b. critical dim drop of exactly 10 → warning (not error; threshold is >10)', () => {
    const result: EvalResult = {
      ...BASE_RESULT,
      dimensionDeltas: [
        makeDelta({ dimension: 'compliance', label: 'Compliance', before: 80, after: 70, delta: -10, critical: true }),
      ],
    };
    const sarif = buildSarif(result, ['.trustmodel.yml'], BASE_CFG);
    const findings = sarif.runs[0].results;
    expect(findings).toHaveLength(1);
    expect(findings[0].level).toBe('warning');
    expect(findings[0].ruleId).toBe('TR.compliance.warning');
  });
});

describe('buildSarif — clean pass', () => {
  test('4a. all deltas ≥ 0 → empty results array', () => {
    const result: EvalResult = {
      ...BASE_RESULT,
      dimensionDeltas: [
        makeDelta({ before: 70, after: 75, delta:  5 }),
        makeDelta({ dimension: 'safety', label: 'Safety', before: 90, after: 90, delta: 0, critical: true }),
        makeDelta({ dimension: 'accuracy', label: 'Accuracy', before: 60, after: 65, delta: 5, critical: false }),
      ],
    };
    const sarif = buildSarif(result, ['agents/main.py'], BASE_CFG);
    expect(sarif.runs[0].results).toHaveLength(0);
  });

  test('4b. no dimension deltas at all → empty results array', () => {
    const sarif = buildSarif({ ...BASE_RESULT, dimensionDeltas: undefined }, [], BASE_CFG);
    expect(sarif.runs[0].results).toHaveLength(0);
  });

  test('4c. free tier (preliminary scan) with no drops → empty results', () => {
    const result: EvalResult = {
      trustScore: 72, grade: 'C', free: true,
      dimensionDeltas: [
        makeDelta({ before: null, after: 72, delta: 0 }),  // no baseline, score ok
      ],
    };
    const sarif = buildSarif(result, [], BASE_CFG);
    // delta=0, before=null, after≥50 → no result
    expect(sarif.runs[0].results).toHaveLength(0);
  });
});

describe('buildSarif — no baseline', () => {
  test('5. no baseline + score < 50 → note level', () => {
    const result: EvalResult = {
      ...BASE_RESULT,
      dimensionDeltas: [
        makeDelta({ dimension: 'robustness', label: 'Robustness', before: null, after: 42, delta: 0, critical: false }),
      ],
    };
    const sarif = buildSarif(result, ['chains/rag_chain.py'], BASE_CFG);
    const findings = sarif.runs[0].results;
    expect(findings).toHaveLength(1);
    expect(findings[0].level).toBe('note');
    expect(findings[0].ruleId).toBe('TR.robustness.info');
    expect(findings[0].message.text).toContain('no baseline');
  });

  test('6. no baseline + score ≥ 50 → no result', () => {
    const result: EvalResult = {
      ...BASE_RESULT,
      dimensionDeltas: [
        makeDelta({ dimension: 'robustness', label: 'Robustness', before: null, after: 65, delta: 0, critical: false }),
      ],
    };
    const sarif = buildSarif(result, ['chains/rag_chain.py'], BASE_CFG);
    expect(sarif.runs[0].results).toHaveLength(0);
  });
});

describe('buildSarif — compliance gaps', () => {
  test('7. compliance gaps → note-level results', () => {
    const result: EvalResult = {
      ...BASE_RESULT,
      dimensionDeltas: [],
      complianceGaps: ['HIPAA §164.502 — minimum necessary', 'EEOC Title VII disparate impact'],
    };
    const sarif = buildSarif(result, ['agents/hr_screener.py'], BASE_CFG);
    const findings = sarif.runs[0].results;
    expect(findings).toHaveLength(2);
    findings.forEach(f => {
      expect(f.level).toBe('note');
      expect(f.ruleId).toBe('TR.compliance.info');
      expect(f.message.text).toContain('Compliance gap detected');
    });
    expect(findings[0].message.text).toContain('minimum necessary');
    expect(findings[1].message.text).toContain('disparate impact');
  });
});

describe('buildSarif — file location', () => {
  test('8a. first changed file used as location URI', () => {
    const result: EvalResult = {
      ...BASE_RESULT,
      dimensionDeltas: [makeDelta({ before: 80, after: 65, delta: -15, critical: true })],
    };
    const sarif = buildSarif(result, ['prompts/system.txt', 'agents/router.py'], BASE_CFG);
    const loc = sarif.runs[0].results[0].locations[0];
    expect(loc.physicalLocation.artifactLocation.uri).toBe('prompts/system.txt');
    expect(loc.physicalLocation.artifactLocation.uriBaseId).toBe('SRCROOT');
  });

  test('8b. no changed files → location falls back to repo root', () => {
    const result: EvalResult = {
      ...BASE_RESULT,
      dimensionDeltas: [makeDelta({ before: 80, after: 65, delta: -15, critical: true })],
    };
    const sarif = buildSarif(result, [], BASE_CFG);
    const loc = sarif.runs[0].results[0].locations[0];
    expect(loc.physicalLocation.artifactLocation.uri).toBe('.');
  });
});
