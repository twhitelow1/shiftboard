// Plan features. On the multi-restaurant platform each restaurant's plan includes some features (Training,
// tip pool, 86 List, events, forecast, venue…); the server sends them as `features` in /api/config and in
// app.bootstrap (`features`, or `tenant.features`), e.g. { training: true, tips: false }. The app hides the
// tabs, rows and screens of features that are off. Without a `features` object (a restaurant on its own
// deployment, or an older server) everything shows. The server checks again: an RPC for a feature the plan
// doesn't include answers 403.
import type { Boot, ServerConfig } from './types';

/** Feature keys, as the server names them (server/platform/plans.js on the platform). */
export type Feature = 'training' | 'tips' | 'eightySix' | 'events' | 'forecast' | 'venue' | 'toast' | 'sms' | 'announcements' | 'assistant' | 'feedback' | 'feedbackInbox' | 'stock' | 'ratingsView';

export type Features = Partial<Record<string, boolean>> | null;

const asObject = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, boolean>) : null);

/** The restaurant's features: bootstrap's (fresh, after sign-in) or /api/config's, or null when the server sends none. */
export function featuresOf(boot: Boot | null, config: ServerConfig | null): Features {
  return asObject(boot?.features) || asObject(boot?.tenant?.features) || asObject(config?.features) || null;
}

/** On unless the server says it's off. */
export const featureOn = (features: Features, f: Feature) => !features || features[f] !== false;
