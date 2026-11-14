/** Optional website information, never evidence of a PR evaluation. */
export interface WebsiteResult {
  domain: string;
  status: 'assessed' | 'unavailable';
  trustScore: number | null;
}

export function normalizeWebsiteDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  const labels = domain.split('.');
  if (domain.length > 253 || labels.length < 2 || /^\d+$/.test(labels[labels.length - 1])
      || ['localhost', 'local', 'internal', 'test', 'invalid', 'example'].includes(labels[labels.length - 1])
      || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('website_domain must be an explicit public DNS domain, without a URL, path, or port.');
  }
  return domain;
}

export async function scanWebsite(opts: { baseUrl: string; domain: string; transport?: typeof fetch }): Promise<WebsiteResult> {
  const domain = normalizeWebsiteDomain(opts.domain);
  const unavailable: WebsiteResult = { domain, status: 'unavailable', trustScore: null };
  try {
    const response = await (opts.transport ?? fetch)(`${opts.baseUrl}/v1/public/site-score/${encodeURIComponent(domain)}/`, {
      headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return unavailable;
    const data = await response.json() as Record<string, unknown>;
    if (!data || data.domain !== domain || data.assessed !== true
        || typeof data.trust_score !== 'number' || !Number.isFinite(data.trust_score)
        || data.trust_score < 0 || data.trust_score > 100) return unavailable;
    return { domain, status: 'assessed', trustScore: data.trust_score };
  } catch {
    return unavailable;
  }
}

export function websiteComment(result?: WebsiteResult): string {
  if (!result) return '';
  return ['\n\n---', '### Website TrustScore — informational', '', `Website: \`${result.domain}\``, '',
    result.status === 'assessed' ? `Website TrustScore: **${result.trustScore}/100**.` : 'Website TrustScore: unavailable.', '',
    'This is a website assessment (possibly cached), not a review of this PR or its code. It does not affect the PR gate, threshold, or exit code.'].join('\n');
}
