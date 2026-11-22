// Creating a restaurant. One server-side function for every way a restaurant comes to exist: the
// platform console now, and the public sign-up page in phase 2 (server/billing.js). It doesn't depend on
// a console session: the caller passes who did it (a platform admin, or nobody for self-serve sign-up).
//
// It checks the input, registers the restaurant, creates its schema (the same tables as every other
// restaurant, with row-level security on), seeds its settings with its name and its owner as Super
// Admin, and invites the owner through the app's own invite flow: by email when email is set up, or a
// link the caller shows once.
import crypto from 'node:crypto';
import { DocDb } from '../db.js';
import { uid } from '../../core/store.js';
import { DEFAULT_SETTINGS } from '../../core/service.js';
import { slugProblem, schemaForSlug } from './slugs.js';
import { PLAN_KEYS, DEFAULT_PLAN, STATUSES, TRIAL_DAYS, cleanOverrides } from './plans.js';
import { EMPTY_BILLING } from '../billing.js';
import { CONSENT_MIGRATION } from '../../core/consent.js';

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export class OnboardError extends Error {
  constructor(message, status = 400, field = null) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

// A new restaurant's settings: the app's defaults, minus the first restaurant's own room, area and tag
// names, which core/service.js keeps as its defaults for Chasing Rabbits.
function starterSettings(name) {
  return {
    ...DEFAULT_SETTINGS,
    restaurantName: name,
    rooms: ['Dining Room', 'Bar', 'Patio', 'Private Room', 'Full Buyout'],
    departments: ['Leadership', 'Front of House', 'Bar', 'Host', 'Events', 'Kitchen'],
    tags: ['OPEN', 'CLOSE', 'PATIO', 'BAR', 'EVENT'],
    areas: [],
    areaColors: {},
  };
}

/** Check and normalize the input. Throws OnboardError naming the field. */
export function checkTenantInput(input = {}, { now = Date.now() } = {}) {
  const name = String(input.name || '').replace(/\s+/g, ' ').trim();
  if (!name) throw new OnboardError('Enter the restaurant’s name', 400, 'name');
  if (name.length > 80) throw new OnboardError('The name can be up to 80 characters', 400, 'name');
  const slug = String(input.slug || '').trim().toLowerCase();
  const sp = slugProblem(slug);
  if (sp) throw new OnboardError(sp, 400, 'slug');
  const ownerName = String(input.owner?.name || '').replace(/\s+/g, ' ').trim();
  const ownerEmail = String(input.owner?.email || '').trim().toLowerCase();
  if (!ownerName) throw new OnboardError('Enter the owner’s name', 400, 'ownerName');
  if (!EMAIL.test(ownerEmail)) throw new OnboardError('Enter the owner’s email address', 400, 'ownerEmail');
  const plan = input.plan || DEFAULT_PLAN;
  if (!PLAN_KEYS.includes(plan)) throw new OnboardError('Pick a plan', 400, 'plan');
  const status = input.status || 'trialing';
  if (!STATUSES.includes(status)) throw new OnboardError('Pick a status', 400, 'status');
  let trialEndsAt = null;
  if (input.trialEndsAt) {
    const t = Date.parse(input.trialEndsAt);
    if (!Number.isFinite(t)) throw new OnboardError('The trial end isn’t a date', 400, 'trialEndsAt');
    trialEndsAt = new Date(t).toISOString();
  } else if (status === 'trialing') {
    trialEndsAt = new Date(now + TRIAL_DAYS * 86_400_000).toISOString();
  }
  return { name, slug, owner: { name: ownerName, email: ownerEmail }, plan, status, trialEndsAt, features: cleanOverrides(input.features), notes: String(input.notes || '').slice(0, 5000) };
}

/**
 * @param {object} platform  { registry, conn, runtime(tenant) } from server/platform/index.js
 * @param {object} input     { name, slug, owner: { name, email }, plan, trialEndsAt, status, features?, notes? }
 * @param {object} [o]
 * @param {object|null} [o.actor]  the platform admin doing it ({ id, email }), or null for self-serve sign-up
 * @param {string} [o.base]        the restaurant's address for the invite link (https://bistro.shiftboard.app)
 * @param {string} [o.source]      'console' | 'signup' (for the audit log)
 * @returns {Promise<{ tenant, owner: { id, email }, invite: { emailed, to?, link?, error? } }>}
 */
export async function createTenant(platform, input, { actor = null, base = '', source = 'console' } = {}) {
  const { registry, conn } = platform;
  const v = checkTenantInput(input);
  const schema = schemaForSlug(v.slug);

  const snap = await registry.snapshot({ fresh: true });
  if (snap.bySlug.has(v.slug)) throw new OnboardError(`${v.slug} is already taken`, 409, 'slug');

  // Never take over a schema that already holds data (a leftover from something else). An empty one, from
  // an attempt that failed halfway, is fine to use.
  const existing = await conn.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
  if (existing.rows.length) {
    let rows = 0;
    try { rows = Number((await conn.query(`SELECT count(*)::int AS n FROM "${schema}".docs`)).rows[0].n); } catch { /* no docs table */ }
    if (rows) throw new OnboardError(`A database schema named ${schema} already exists with data. Pick another address.`, 409, 'slug');
  }

  let tenant;
  try {
    tenant = await registry.insertTenant({
      id: `ten_${crypto.randomBytes(6).toString('hex')}`, slug: v.slug, name: v.name, schema_name: schema, status: v.status, plan: v.plan,
      features: v.features, owner_email: v.owner.email, owner_name: v.owner.name, trial_ends_at: v.trialEndsAt, notes: v.notes, billing: EMPTY_BILLING,
    });
  } catch (e) {
    if (e.code === '23505') throw new OnboardError(`${v.slug} is already taken`, 409, 'slug');
    throw e;
  }

  let ownerId;
  try {
    const db = new DocDb(conn, { schema });
    await db.migrate();
    ownerId = await db.run((store) => {
      if (!store.get('settings', 'settings')) store.insert('settings', starterSettings(v.name));
      // A new restaurant has nobody from before consent records: its people agree on the consent screen.
      if (!store.get('migrations', CONSENT_MIGRATION)) store.insert('migrations', { id: CONSENT_MIGRATION, at: new Date().toISOString(), users: 0 });
      const already = store.list('users', (u) => u.email === v.owner.email)[0];
      if (already) return already.id;
      return store.insert('users', {
        id: uid('usr'), name: v.owner.name, email: v.owner.email, role: 'super_admin', jobCodes: [], active: true, availability: {},
        smsConsent: false, emailConsent: false, createdAt: new Date().toISOString(),
      }).id;
    }, { write: true });
  } catch (e) {
    await registry.deleteTenantRow(tenant.id).catch(() => {});
    throw e;
  }

  // The owner's invite, through the restaurant's own app (its email settings, its branding, its language).
  let invite;
  try {
    const rt = await platform.runtime(tenant);
    invite = await rt.app.locals.invite(ownerId, { invitedBy: 'DubLow Digital', base });
  } catch (e) {
    // The email didn't go: show the link instead, so the owner can still be let in.
    console.error('Owner invite email failed:', e.message);
    try {
      const rt = await platform.runtime(tenant);
      invite = { ...(await rt.app.locals.invite(ownerId, { base, linkOnly: true })), error: `The invite email could not be sent (${e.message})` };
    } catch (e2) { invite = { emailed: false, error: e2.message }; }
  }

  await registry.audit({
    admin: actor, action: 'tenant.create', tenantId: tenant.id,
    details: { slug: v.slug, name: v.name, plan: v.plan, status: v.status, trialEndsAt: v.trialEndsAt, owner: v.owner.email, source, invite: invite.emailed ? 'emailed' : invite.link ? 'link shown once' : 'failed' },
  });
  return { tenant, owner: { id: ownerId, email: v.owner.email }, invite };
}
