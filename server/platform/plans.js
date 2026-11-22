// Plans, prices, statuses and the features each plan includes: the one place to change them.
//
// A restaurant (tenant) has a plan, and DubLow can switch any feature on or off for one restaurant on top
// of its plan (tenants.features in the platform schema). Scheduling, trades, time off, notifications,
// email, phone notifications, team and settings are in every plan; the features below are the add-ons.
// The server enforces them (an RPC for a feature the restaurant doesn't have answers 403 "Not included in
// your plan", and so do its routes) and the web app hides their pages and cards (bootstrap and /api/config
// carry the restaurant's features).
//
// Phase 2 (Stripe, see server/billing.js) maps each plan to a Stripe Price: set STRIPE_PRICE_STARTER and
// STRIPE_PRICE_PRO, and planForPrice() turns a subscription's price back into a plan.

export const FEATURES = [
  { key: 'training', label: 'Training', hint: 'Menu study guide, quizzes, leaderboard, employee manual, manager on duty' },
  { key: 'tips', label: 'Tip pool', hint: 'Pools, daily tips, weekly split' },
  { key: 'eightySix', label: '86 List', hint: 'What’s out or running low, with photos' },
  { key: 'events', label: 'Events & BEOs', hint: 'Banquet event orders and event staffing' },
  { key: 'forecast', label: 'Forecast & labor', hint: 'Sales history, forecast, labor rules and labor review' },
  { key: 'toast', label: 'Toast POS', hint: 'Daily sales, covers and clock-ins from Toast' },
  { key: 'sms', label: 'Text messages', hint: 'Notifications by text (Twilio)' },
  { key: 'venue', label: 'Venue & floor plans', hint: 'Rooms, floor plans and server sections' },
  { key: 'multiLocation', label: 'Multiple locations', hint: 'Placeholder for a later phase; nothing uses it yet' },
];
export const FEATURE_KEYS = FEATURES.map((f) => f.key);

/**
 * Each plan: its name, monthly price in cents (working prices), whether restaurants can pick it at
 * sign-up, the env var holding its Stripe Price id (phase 2), and its features. Restaurants follow their
 * plan unless a feature is overridden.
 */
export const PLANS = {
  starter: {
    label: 'Starter', priceCents: 4900, interval: 'month', selfServe: true, stripePriceEnv: 'STRIPE_PRICE_STARTER',
    features: ['training', 'tips', 'eightySix'],
  },
  pro: {
    label: 'Pro', priceCents: 9900, interval: 'month', selfServe: true, stripePriceEnv: 'STRIPE_PRICE_PRO',
    features: ['training', 'tips', 'eightySix', 'events', 'forecast', 'toast', 'sms', 'venue'],
  },
  beta: {
    label: 'Beta (everything, free)', priceCents: 0, interval: 'month', selfServe: false, stripePriceEnv: null,
    features: FEATURE_KEYS,
  },
};
export const PLAN_KEYS = Object.keys(PLANS);
export const DEFAULT_PLAN = 'starter';
export const TRIAL_DAYS = 14;

/** The Stripe Price id for a plan (phase 2), from env, or null. */
export const stripePriceFor = (plan, env = process.env) => (PLANS[plan]?.stripePriceEnv ? env[PLANS[plan].stripePriceEnv] || null : null);
/** The plan a Stripe Price id stands for (phase 2), or null. */
export function planForPrice(priceId, env = process.env) {
  if (!priceId) return null;
  return PLAN_KEYS.find((k) => stripePriceFor(k, env) === priceId) || null;
}

/**
 * trialing: free trial until trial_ends_at. active: paying (or the free beta). past_due: a payment failed,
 * still open while Stripe retries. suspended / canceled: can't sign in; the data is kept.
 */
export const STATUSES = ['trialing', 'active', 'past_due', 'suspended', 'canceled'];
export const isPaused = (status) => status === 'suspended' || status === 'canceled';

/**
 * The billing banner a restaurant's admins see (never staff), or null. Non-blocking; its button opens
 * the billing portal, which is a stub until phase 2 (server/billing.js).
 *   { kind: 'trial', daysLeft }  "Your free trial ends in N days"
 *   { kind: 'pastDue' }          "Payment failed. Update your card."
 */
export function billingBanner(tenant, now = Date.now()) {
  if (!tenant) return null;
  if (tenant.status === 'past_due') return { kind: 'pastDue' };
  if (tenant.status === 'trialing' && tenant.trial_ends_at) {
    const ms = Date.parse(tenant.trial_ends_at) - now;
    // Whole days left: a trial ending tonight says "today", one ending in 14½ days says 14.
    return { kind: 'trial', daysLeft: Math.max(0, Math.floor(ms / 86_400_000)), endsAt: tenant.trial_ends_at };
  }
  return null;
}

/** A plan's features with the restaurant's overrides ({ tips: false, toast: true }) on top: { training: true, … }. */
export function resolveFeatures(plan, overrides = {}) {
  const base = new Set(PLANS[plan]?.features || PLANS[DEFAULT_PLAN].features);
  const out = {};
  for (const k of FEATURE_KEYS) out[k] = typeof overrides?.[k] === 'boolean' ? overrides[k] : base.has(k);
  return out;
}

/** Keep only known features with true/false values (anything else means "follow the plan"). */
export function cleanOverrides(raw) {
  const out = {};
  for (const k of FEATURE_KEYS) if (typeof raw?.[k] === 'boolean') out[k] = raw[k];
  return out;
}

// RPC namespaces (core/service.js and the modules it pulls in) that belong to a feature.
const NAMESPACE_FEATURE = {
  training: 'training', menu: 'training', quiz: 'training', leaderboard: 'training', manual: 'training', mod: 'training',
  tipPools: 'tips', tipEntries: 'tips', tips: 'tips', myTips: 'tips',
  eightySix: 'eightySix',
  events: 'events',
  forecast: 'forecast', sales: 'forecast', labor: 'forecast',
  toast: 'toast',
  sms: 'sms',
  venue: 'venue', sections: 'venue',
};
const METHOD_FEATURE = { 'settings.laborRules': 'forecast' };

/** The feature an RPC method needs, or null when it's in every plan. */
export function featureForMethod(method) {
  const m = String(method || '');
  return METHOD_FEATURE[m] || NAMESPACE_FEATURE[m.split('.')[0]] || null;
}

// HTTP routes (server/app.js and the modules it mounts) that belong to a feature.
export const ROUTE_FEATURES = [
  ['/api/toast', 'toast'],
  ['/api/training', 'training'],
  ['/api/eighty-six', 'eightySix'],
  ['/api/sms', 'sms'],
  ['/api/twilio', 'sms'],
];

export const NOT_IN_PLAN = 'Not included in your plan';
export const PAUSED = 'This restaurant’s account is paused. Contact DubLow Digital.';
