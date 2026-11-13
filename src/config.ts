import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';

export interface Config {
  apiKey: string;
  threshold: number;
  framework?: string;
  blockOnRegression: boolean;
  certOnPass: boolean;
  detectPatterns: string[];
  baseUrl: string;
}

interface TrustmodelYml {
  detect?: string[];
  eval?: {
    threshold?: number;
    framework?: string;
    block_on_regression?: boolean;
    cert_on_pass?: boolean;
  };
}

export async function readTrustmodelConfig(overrides: Config): Promise<Config> {
  // .trustmodel.yml in the repo root takes precedence, then action inputs.
  const cfgFile = '.trustmodel.yml';
  if (existsSync(cfgFile)) {
    try {
      const doc = yaml.load(readFileSync(cfgFile, 'utf8')) as TrustmodelYml;
      return {
        apiKey:            overrides.apiKey,
        threshold:         overrides.threshold || doc.eval?.threshold || 65,
        framework:         overrides.framework || doc.eval?.framework,
        blockOnRegression: overrides.blockOnRegression ?? (doc.eval?.block_on_regression !== false),
        certOnPass:        overrides.certOnPass || doc.eval?.cert_on_pass || false,
        detectPatterns:    overrides.detectPatterns.length > 0
                             ? overrides.detectPatterns
                             : (doc.detect ?? []),
        baseUrl:           overrides.baseUrl || 'https://api.trustmodel.ai',
      };
    } catch { /* malformed yaml — fall through to overrides */ }
  }
  return { ...overrides, threshold: overrides.threshold || 65 };
}
