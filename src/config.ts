import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';

export interface Config {
  apiKey: string;
  threshold: number;
  framework?: string;
  detectPatterns: string[];
  baseUrl: string;
}

export async function readTrustmodelConfig(overrides: Omit<Config, 'threshold'> & { threshold?: number }): Promise<Config> {
  let doc: { detect?: unknown; eval?: { threshold?: unknown; framework?: unknown } } = {};
  if (existsSync('.trustmodel.yml')) {
    const raw = readFileSync('.trustmodel.yml', 'utf8');
    if (Buffer.byteLength(raw) > 65536) throw new Error('Trust Review configuration is too large.');
    const parsed = yaml.load(raw);
    if (parsed !== undefined && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
      throw new Error('Invalid Trust Review configuration.');
    }
    doc = (parsed || {}) as typeof doc;
  }
  const threshold = overrides.threshold ?? doc.eval?.threshold ?? 65;
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1 || threshold > 100) {
    throw new Error('threshold must be an integer from 1 to 100; the server may enforce a higher minimum.');
  }
  const detectPatterns = overrides.detectPatterns.length ? overrides.detectPatterns : (doc.detect ?? []);
  if (!Array.isArray(detectPatterns) || detectPatterns.some(p => typeof p !== 'string' || p.length > 512)) {
    throw new Error('detect must be an array of file-path patterns.');
  }
  const base = new URL(overrides.baseUrl);
  if (base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)
      || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw new Error('base_url must be an HTTPS gateway origin (HTTP is supported only for localhost tests).');
  }
  const framework = overrides.framework || doc.eval?.framework;
  if (framework !== undefined && (typeof framework !== 'string' || framework.length > 64)) throw new Error('Invalid framework.');
  return { ...overrides, baseUrl: base.origin, threshold, framework, detectPatterns };
}
