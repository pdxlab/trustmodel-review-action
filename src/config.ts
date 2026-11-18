import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';

export type TrMode = 'advisory' | 'enforce';

export interface Config {
  apiKey: string;
  mode: TrMode;
  threshold: number;
  framework?: string;
  blockOnRegression: boolean;
  certOnPass: boolean;
  detectPatterns: string[];
  detectDebug: boolean;
  baseUrl: string;
}

interface TrustmodelYml {
  detect?: string[];
  eval?: {
    threshold?: number;
    framework?: string;
    mode?: TrMode;
    block_on_regression?: boolean;
    cert_on_pass?: boolean;
  };
}

export async function readTrustmodelConfig(overrides: Config): Promise<Config> {
  // .trustmodel.yml or .trustreview.yml in the repo root (vendor-neutral name).
  const cfgFile = existsSync('.trustreview.yml') ? '.trustreview.yml'
                : existsSync('.trustmodel.yml')  ? '.trustmodel.yml'
                : null;

  if (cfgFile) {
    try {
      const doc = yaml.load(readFileSync(cfgFile, 'utf8')) as TrustmodelYml;
      return {
        apiKey:            overrides.apiKey,
        mode:              overrides.mode || doc.eval?.mode || 'advisory',
        threshold:         overrides.threshold || doc.eval?.threshold || 65,
        framework:         overrides.framework || doc.eval?.framework,
        blockOnRegression: overrides.blockOnRegression ?? (doc.eval?.block_on_regression !== false),
        certOnPass:        overrides.certOnPass || doc.eval?.cert_on_pass || false,
        detectPatterns:    overrides.detectPatterns.length > 0
                             ? overrides.detectPatterns
                             : (doc.detect ?? []),
        detectDebug:       overrides.detectDebug,
        baseUrl:           overrides.baseUrl || 'https://api.trustmodel.ai',
      };
    } catch { /* malformed yaml */ }
  }
  return { ...overrides, threshold: overrides.threshold || 65, mode: overrides.mode || 'advisory' };
}
