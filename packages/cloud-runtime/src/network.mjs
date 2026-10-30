import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const DENIED_SUBNETS = Object.freeze([
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '224.0.0.0/4', '240.0.0.0/4', '::/128', '::1/128', '::ffff:0:0/96',
  'fc00::/7', 'fe80::/10', 'ff00::/8',
]);

function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)));
  }
  const ipv6 = address.toLowerCase();
  return isIP(address) === 6 && !/^(?:::(?:1|ffff:.*)?|f[cd].*|fe[89ab].*|ff.*)$/.test(ipv6);
}

export function domainName(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase() ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) ||
      value === 'falcondeck.com' || value.endsWith('.falcondeck.com') ||
      /\.(?:localhost|local|internal|test|invalid)$/.test(value)) throw new Error('Invalid or prohibited egress domain');
  return value;
}

export function httpsEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search) throw new Error('Endpoint must be public HTTPS without credentials or query');
  domainName(url.hostname);
  return url;
}

// The existing release distributor shares the production relay hostname. Its
// explicit immutable-by-digest binary is the sole boot-only exception; no relay
// or control API is available through this rule.
export function daemonEndpoint(value) {
  const url = new URL(value);
  if (url.protocol === 'https:' && url.hostname === 'connect.falcondeck.com' &&
      !url.username && !url.password && !url.port && !url.hash && !url.search &&
      /^\/dist\/falcondeck-daemon-(?:x86_64|aarch64)-linux$/.test(url.pathname)) return url;
  return httpsEndpoint(value);
}

export async function networkPolicy(request, resolve = lookup, { bootstrap = false } = {}) {
  if (!Array.isArray(request.allowed_domains) || request.allowed_domains.length > 64) throw new Error('Explicit allowed_domains required');
  const artifact = request.worker_daemon_url ? daemonEndpoint(request.worker_daemon_url) : null;
  const bootArtifact = artifact?.hostname === 'connect.falcondeck.com';
  const domains = [...new Set(request.allowed_domains.map(value =>
    bootArtifact && value === artifact.hostname ? value : domainName(value)))].sort();
  const modelEndpoint = httpsEndpoint(request.model_base_url ?? 'https://api.openai.com/v1');
  const required = [modelEndpoint.hostname];
  if (artifact && !bootArtifact) required.push(artifact.hostname);
  if (required.some(domain => !domains.includes(domain))) throw new Error('Model and daemon download domains must be explicitly allowed');
  for (const domain of new Set([...domains, ...(bootArtifact ? [artifact.hostname] : [])])) {
    const addresses = await resolve(domain, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Egress domain resolves to a prohibited network');
  }
  const runningDomains = domains.filter(domain => !bootArtifact || domain !== artifact.hostname);
  // Domain policy is not a URL/method policy. During trusted preparation only,
  // the downloader enforces the exact GET URL, checksum and no redirects.
  if (bootstrap && bootArtifact) return { allow: [...runningDomains, artifact.hostname], subnets: { deny: [...DENIED_SUBNETS] } };
  return { allow: runningDomains, subnets: { deny: [...DENIED_SUBNETS] } };
}
