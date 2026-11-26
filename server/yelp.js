// Yelp Places API (formerly Yelp Fusion) client: an API key as a bearer token, read-only.
// Verified against Yelp's reference (docs/integrations/GOOGLE-YELP.md has the links):
//   reviews   GET https://api.yelp.com/v3/businesses/{business_id_or_alias}/reviews   up to 3 excerpts (Enhanced
//             plan; up to 7 on Premium; none on Base), Yelp's own order; { reviews: [{ id, url, text, rating,
//             time_created, user: { id, profile_url, image_url, name } }], total, possible_languages }
//   details   GET https://api.yelp.com/v3/businesses/{business_id_or_alias}               id, alias, name, url…
//   search    GET https://api.yelp.com/v3/businesses/search?term=…&location=…             to find the business
// There is no API to reply to a review (owners reply in Yelp for Business), and no full review text.
// Env: YELP_API_KEY (DubLow's platform-wide key, or a restaurant's own in Settings → Integrations, secret),
// YELP_BUSINESS_ID (the restaurant's id or alias). 429 means the plan's daily limit (resets at midnight UTC).
export const HOST = 'https://api.yelp.com';
export const NEEDED = ['YELP_API_KEY', 'YELP_BUSINESS_ID'];

export class YelpError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

const val = (env, k) => String(env[k] || '').trim();
/** Which settings are present (names only, never values). */
export function yelpConfig(env = process.env) {
  const missing = NEEDED.filter((k) => !val(env, k));
  return { configured: !missing.length, missing, hasKey: !!val(env, 'YELP_API_KEY'), businessId: val(env, 'YELP_BUSINESS_ID'), cron: !!val(env, 'CRON_SECRET') };
}
const ID_RE = /^[A-Za-z0-9_-]{2,120}$/;

export function createYelpClient({ env = process.env, fetch, host = HOST, timeoutMs = 12_000 } = {}) {
  const doFetch = (...a) => (fetch || globalThis.fetch)(...a);
  const key = val(env, 'YELP_API_KEY');
  const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined);

  async function get(path, q = {}) {
    if (!key) throw new YelpError('There’s no Yelp API key yet. Add one in Settings → Integrations → Yelp.', 400);
    const u = new URL(`${host}${path}`);
    for (const [k, v] of Object.entries(q)) if (v != null && v !== '') u.searchParams.set(k, String(v));
    let res;
    try { res = await doFetch(u.toString(), { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: signal() }); } catch (e) {
      throw new YelpError(`Couldn’t reach Yelp (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
    }
    const body = await res.json().catch(() => null);
    if (res.ok) return body || {};
    const code = String(body?.error?.code || '');
    if (res.status === 401 || code === 'TOKEN_INVALID' || code === 'UNAUTHORIZED_ACCESS_TOKEN') throw new YelpError('Yelp didn’t accept the API key. Check it in Settings → Integrations → Yelp.', 401);
    if (res.status === 403) throw new YelpError('Yelp says this API key’s plan doesn’t include reviews. Reviews need Yelp’s Enhanced or Premium plan.', 403);
    if (res.status === 404 || code === 'BUSINESS_NOT_FOUND') throw new YelpError('Yelp couldn’t find that business. Check the business ID or alias.', 404);
    if (res.status === 429) throw new YelpError('Yelp’s daily limit for this API key is used up. It resets at midnight UTC.', 429);
    throw new YelpError(`Yelp answered ${res.status}${body?.error?.description ? `: ${String(body.error.description).slice(0, 160)}` : ''}`, res.status);
  }
  const biz = (b) => ({
    id: String(b.id || ''), alias: String(b.alias || ''), name: String(b.name || ''), rating: b.rating ?? null, reviewCount: b.review_count ?? null,
    address: Array.isArray(b.location?.display_address) ? b.location.display_address.join(', ') : [b.location?.address1, b.location?.city].filter(Boolean).join(', '),
    url: /^https:\/\/([a-z0-9-]+\.)*yelp\.[a-z.]+\//i.test(String(b.url || '')) ? String(b.url).split('?')[0] : '',
  });

  return {
    /** The business by id or alias. */
    async business(idOrAlias) {
      if (!ID_RE.test(String(idOrAlias || ''))) throw new YelpError('A Yelp business ID or alias is letters, numbers and dashes', 400);
      return biz(await get(`/v3/businesses/${encodeURIComponent(idOrAlias)}`));
    },
    /** Businesses matching a name near a place (to find the restaurant's id). */
    async search(term, location) {
      const d = await get('/v3/businesses/search', { term: String(term || '').slice(0, 80), location: String(location || '').slice(0, 120), limit: 5 });
      return (Array.isArray(d.businesses) ? d.businesses : []).map(biz);
    },
    /** The review excerpts Yelp gives for the business: the raw rows (core/yelp-reviews.js reads them). */
    async reviews(idOrAlias = val(env, 'YELP_BUSINESS_ID')) {
      if (!ID_RE.test(String(idOrAlias || ''))) throw new YelpError('There’s no Yelp business yet. Find it in Settings → Integrations → Yelp.', 400);
      const d = await get(`/v3/businesses/${encodeURIComponent(idOrAlias)}/reviews`, { limit: 7, sort_by: 'yelp_sort' });
      return Array.isArray(d.reviews) ? d.reviews : [];
    },
  };
}
