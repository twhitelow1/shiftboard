// A restaurant's slug is its subdomain (bistro → bistro.<PLATFORM_DOMAIN>) and names its Postgres
// schema (t_bistro). The rules live here only, for the platform console now and self-serve sign-up later.
// Uniqueness is checked against the registry (platform.tenants.slug is UNIQUE).

/** Subdomains a restaurant can't have. */
export const RESERVED_SLUGS = ['admin', 'www', 'api', 'app', 'platform', 'mail', 'email', 'smtp', 'support', 'help',
  'status', 'static', 'assets', 'cdn', 'docs', 'blog', 'billing', 'signup', 'login', 'dashboard'];

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Why a slug can't be used (format or reserved), or null. */
export function slugProblem(slug) {
  const s = String(slug ?? '');
  if (s.length < 2) return 'The address needs at least 2 characters';
  if (!SLUG.test(s)) return 'Use lowercase letters, numbers and dashes (not at the start or end), up to 40 characters';
  if (s.includes('--')) return 'Use single dashes';
  if (RESERVED_SLUGS.includes(s)) return `“${s}” is reserved`;
  return null;
}

/** A suggested slug for a restaurant name: "The Rabbit Hole Café" → "the-rabbit-hole-cafe". */
export function slugify(name) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

/** The Postgres schema for a new restaurant. Slugs have no underscores, so this is one-to-one. */
export const schemaForSlug = (slug) => `t_${String(slug).replace(/-/g, '_')}`;
