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
  { key: 'announcements', label: 'Announcements', hint: 'Managers message the team: in the app, phone notifications, email; texts with Text messages' },
  { key: 'events', label: 'Events & BEOs', hint: 'Banquet event orders and event staffing' },
  { key: 'forecast', label: 'Forecast & labor', hint: 'Sales history, forecast, labor rules and labor review' },
  { key: 'toast', label: 'Toast POS', hint: 'Daily sales, covers and clock-ins from Toast' },
  { key: 'adp', label: 'ADP clock-ins', hint: 'Actual hours from ADP: timecard CSV import and daily sync' },
  { key: 'tripleseat', label: 'Tripleseat (events)', hint: 'Events booked in Tripleseat flow into Events & BEOs: daily sync and webhook' },
  { key: 'opentable', label: 'OpenTable', hint: 'Reservations and reviews from OpenTable: exports today, API sync once OpenTable grants access' },
  { key: 'impact', label: 'Positive impact', hint: 'Staff named in 5-star reviews, guests asking for someone, kudos; reports by season' },
  // One feature for Google Business Profile and Yelp: they share the reply workflow, the alerts and the AI drafts,
  // and a restaurant buys "reviews", not a vendor. It builds on Positive impact (its Reviews tab), so it needs both.
  { key: 'reviews', label: 'Google & Yelp reviews', hint: 'Google Business Profile and Yelp reviews pulled in daily, review alerts, replies (AI drafts, post to Google)' },
  { key: 'sms', label: 'Text messages', hint: 'Notifications by text (Twilio)' },
  { key: 'venue', label: 'Venue & floor plans', hint: 'Rooms, floor plans and server sections' },
  { key: 'multiLocation', label: 'Multiple locations', hint: 'Placeholder for a later phase; nothing uses it yet' },
  // Feedback box (core/feedback.js): in every plan. A restaurant's admins decide who reads it (Settings → Feedback box).
  { key: 'feedback', label: 'Feedback box', hint: 'Anonymous (or signed) suggestions, feedback, concerns and shout-outs; the readers’ inbox and “You said, we did”' },
  // Stock lists (core/stock.js): restock lists for barbacks and the team, and the product catalog the 86 List shares. Every plan.
  { key: 'stock', label: 'Stock lists', hint: 'Restock lists with product photos, assigned to a person, a position or a room; the shared product catalog' },
  { key: 'reports', label: 'Reports', hint: 'Reports for managers, starting with the 86 List report (each report also needs its own feature)' },
  // Claude connector (server/mcp/): Pro and Beta. Not Starter: most of what it does for a restaurant is managers'
  // work (drafts, approvals, forecast, events) that's Pro already; DubLow can switch it on for one restaurant.
  { key: 'mcp', label: 'Claude connector', hint: 'People use ShiftBoard from Claude (claude.ai, Desktop, phone, Claude Code) as themselves' },
  // Ask ShiftBoard (server/assistant/, server/ai/): Claude built into the app, metered and capped per restaurant
  // (aiMonthlyCapUsd below; DubLow can change one restaurant's cap in the console). Pro and Beta, like the connector.
  { key: 'assistant', label: 'Ask ShiftBoard', hint: 'Claude built into the app: answers about the schedule, the 86 List and more; changes only after a tap on Confirm' },
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
    features: ['training', 'tips', 'eightySix', 'reports', 'announcements', 'feedback', 'stock'],
  },
  pro: {
    label: 'Pro', priceCents: 9900, interval: 'month', selfServe: true, stripePriceEnv: 'STRIPE_PRICE_PRO',
    features: ['training', 'tips', 'eightySix', 'events', 'forecast', 'toast', 'adp', 'tripleseat', 'sms', 'venue', 'reports', 'announcements', 'mcp', 'opentable', 'impact', 'assistant', 'reviews', 'feedback', 'stock'],
    aiMonthlyCapUsd: 5, // what DubLow pays for AI per restaurant per month at most (server/ai/); a restaurant's own key isn't capped
  },
  beta: {
    label: 'Beta (everything, free)', priceCents: 0, interval: 'month', selfServe: false, stripePriceEnv: null,
    features: FEATURE_KEYS,
    aiMonthlyCapUsd: 5,
  },
};
export const PLAN_KEYS = Object.keys(PLANS);
/** What DubLow pays for AI per restaurant per month at most, unless a plan says otherwise (server/ai/). */
export const DEFAULT_AI_CAP_USD = 5;
/** The AI cap (USD per month on DubLow's key) a plan comes with; a restaurant's override in the console wins. */
export const planAiCap = (plan) => (Number(PLANS[plan]?.aiMonthlyCapUsd) >= 0 && PLANS[plan]?.aiMonthlyCapUsd != null ? Number(PLANS[plan].aiMonthlyCapUsd) : DEFAULT_AI_CAP_USD);
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
  training: 'training', menu: 'training', quiz: 'training', leaderboard: 'training', manual: 'training', // mod.* (managers on duty) is in every plan
  tipPools: 'tips', tipEntries: 'tips', tips: 'tips', myTips: 'tips',
  eightySix: 'eightySix',
  events: 'events',
  forecast: 'forecast', sales: 'forecast', labor: 'forecast',
  toast: 'toast',
  adp: 'adp',
  tripleseat: 'tripleseat',
  opentable: 'opentable', impact: 'impact',
  clock: 'forecast', calibration: 'forecast',
  sms: 'sms',
  venue: 'venue', sections: 'venue',
  reports: 'reports',
  announcements: 'announcements',
  feedback: 'feedback',
  stock: 'stock', products: 'stock',
};
const METHOD_FEATURE = { 'settings.laborRules': 'forecast' };
// Methods that need more than one feature: each report needs Reports and its own feature.
const PREFIX_FEATURES = [['reports.eightySix.', ['reports', 'eightySix']], ['reviews.', ['impact', 'reviews']]];

/** Every feature an RPC method needs ([] when it's in every plan). */
export function featuresForMethod(method) {
  const m = String(method || '');
  const multi = PREFIX_FEATURES.find(([prefix]) => m.startsWith(prefix));
  if (multi) return [...multi[1]];
  const one = METHOD_FEATURE[m] || NAMESPACE_FEATURE[m.split('.')[0]] || null;
  return one ? [one] : [];
}
/** The (first) feature an RPC method needs, or null when it's in every plan. */
export const featureForMethod = (method) => featuresForMethod(method)[0] || null;

// HTTP routes (server/app.js and the modules it mounts) that belong to a feature.
export const ROUTE_FEATURES = [
  ['/api/toast', 'toast'],
  ['/api/adp', 'adp'],
  ['/api/tripleseat', 'tripleseat'],
  ['/api/opentable', 'opentable'],
  ['/api/google', 'reviews'],
  ['/api/yelp', 'reviews'],
  ['/api/reviews', 'reviews'],
  ['/api/training', 'training'],
  ['/api/eighty-six', 'eightySix'],
  ['/api/stock', 'stock'],
  ['/api/venue', 'venue'],
  ['/api/sms', 'sms'],
  ['/api/twilio', 'sms'],
];

export const NOT_IN_PLAN = 'Not included in your plan';
export const PAUSED = 'This restaurant’s account is paused. Contact DubLow Digital.';
