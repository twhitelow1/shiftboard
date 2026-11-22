// Which restaurant a request is for, from its Host. Pure functions, so they're easy to test.
//
//   1. An exact match on a restaurant's domains (a custom domain, or a spare *.vercel.app alias).
//   2. <slug>.<PLATFORM_DOMAIN>, e.g. bistro.shiftboard.app. admin.<PLATFORM_DOMAIN> is the platform console.
//   3. The legacy fallback: hosts in LEGACY_HOSTS, or any host at all when PLATFORM_DOMAIN isn't set
//      (local development, tests, a single-restaurant install), go to the default restaurant
//      (Chasing Rabbits, schema shiftboard). That keeps every existing address working.
//   Anything else under the platform domain, or any other host once PLATFORM_DOMAIN is set, is
//   "restaurant not found": never another restaurant's data.

import { RESERVED_SLUGS } from './slugs.js';

export { RESERVED_SLUGS, slugProblem, slugify, schemaForSlug } from './slugs.js';

/** "Bistro.Example.com:443." → "bistro.example.com" */
export function normalizeHost(host) {
  let h = String(host || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.replace(/\]:\d+$/, ']'); // IPv6 literal
  h = h.replace(/:\d+$/, '').replace(/\.$/, '');
  return h;
}

const list = (v) => String(v || '').split(',').map(normalizeHost).filter(Boolean);

/** The routing settings from env: PLATFORM_DOMAIN and LEGACY_HOSTS. */
export function hostConfig(env = process.env) {
  const platformDomain = normalizeHost(env.PLATFORM_DOMAIN).replace(/^\*\./, '');
  return {
    platformDomain,
    adminHost: platformDomain ? `admin.${platformDomain}` : '',
    legacyHosts: new Set(list(env.LEGACY_HOSTS)),
  };
}

/** Is this host one where the platform console may answer (admin.<domain>, or /platform on a legacy host)? */
export function consoleAllowed(host, cfg) {
  const h = normalizeHost(host);
  if (!cfg.platformDomain) return true;
  return h === cfg.adminHost || cfg.legacyHosts.has(h);
}

/**
 * @param {string} host
 * @param cfg  from hostConfig()
 * @param reg  { byDomain: Map<host, tenant>, bySlug: Map<slug, tenant>, defaultTenant }
 * @returns {{ kind: 'tenant', tenant, via: 'domain'|'subdomain'|'legacy' } | { kind: 'console' } | { kind: 'notFound' }}
 */
export function resolveHost(host, cfg, reg) {
  const h = normalizeHost(host);
  const exact = reg.byDomain.get(h);
  if (exact) return { kind: 'tenant', tenant: exact, via: 'domain' };
  if (cfg.platformDomain) {
    if (h === cfg.adminHost) return { kind: 'console' };
    if (h.endsWith(`.${cfg.platformDomain}`)) {
      const label = h.slice(0, -(cfg.platformDomain.length + 1));
      const t = !label.includes('.') && !RESERVED_SLUGS.includes(label) ? reg.bySlug.get(label) : null;
      return t ? { kind: 'tenant', tenant: t, via: 'subdomain' } : { kind: 'notFound' };
    }
    if (!cfg.legacyHosts.has(h)) return { kind: 'notFound' };
  }
  return reg.defaultTenant ? { kind: 'tenant', tenant: reg.defaultTenant, via: 'legacy' } : { kind: 'notFound' };
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** Why a domain can't be given to a restaurant, or null. Uniqueness across restaurants is checked by the registry. */
export function domainProblem(domain, cfg) {
  const d = normalizeHost(domain);
  if (!HOSTNAME.test(d)) return `“${domain}” isn’t a domain name like schedule.example.com`;
  if (cfg.legacyHosts.has(d)) return `${d} is a legacy host (LEGACY_HOSTS); it already goes to the default restaurant`;
  if (cfg.platformDomain && (d === cfg.platformDomain || d.endsWith(`.${cfg.platformDomain}`))) {
    return `${d} is under the platform domain; restaurants get <slug>.${cfg.platformDomain} automatically`;
  }
  return null;
}

/**
 * The restaurant's address for links made outside one of its own requests (the console's invite link
 * and "Sign in as owner"). proto and port come from the console's own request, so it also works on
 * http://admin.lvh.me:3000 in development. Null when it has no address yet.
 */
export function tenantAddress(tenant, cfg, { proto = 'https', port = '', consoleHost = '' } = {}) {
  const p = port ? `:${port}` : '';
  if (tenant.domains?.length) return `${proto}://${tenant.domains[0]}${p}`;
  if (!tenant.is_default && cfg.platformDomain) return `${proto}://${tenant.slug}.${cfg.platformDomain}${p}`;
  if (tenant.is_default) {
    if (consoleHost && (!cfg.platformDomain || cfg.legacyHosts.has(normalizeHost(consoleHost)))) return `${proto}://${normalizeHost(consoleHost)}${p}`;
    const legacy = [...cfg.legacyHosts][0];
    if (legacy) return `${proto}://${legacy}${p}`;
  }
  return null;
}
