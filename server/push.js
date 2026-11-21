// Phone notifications through Web Push (VAPID), for the installed web app on Android and iPhone.
//
// Optional: without VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT nothing is pushed.
// Generate a key pair with `node scripts/vapid-keys.js`.

/** Sends with the web-push package, loaded on first use so cold starts don't pay for it. */
async function webPushSend(subscription, payload, options) {
  const { default: webpush } = await import('web-push');
  return webpush.sendNotification(subscription, payload, options);
}

/**
 * @param {object} env
 * @param {object} [opts]
 * @param {Function} [opts.send]  (subscription, payload, options) => Promise; tests pass a fake
 */
export function createPusher(env = process.env, { send = webPushSend } = {}) {
  const publicKey = env.VAPID_PUBLIC_KEY || '';
  const privateKey = env.VAPID_PRIVATE_KEY || '';
  const subject = env.VAPID_SUBJECT || ''; // mailto:you@yourrestaurant.com or https://your-site
  const enabled = !!(publicKey && privateKey && /^(mailto:|https:\/\/)/.test(subject));

  return {
    enabled,
    publicKey: enabled ? publicKey : '',
    /**
     * Push one message to one phone. Resolves { ok: true }, or { gone: true } when the push service
     * says the subscription no longer exists (404/410: remove it). Other failures reject.
     */
    async send(subscription, message) {
      if (!enabled) throw new Error('Phone notifications are not set up (VAPID_* settings)');
      try {
        await send({ endpoint: subscription.endpoint, keys: subscription.keys }, JSON.stringify(message), {
          vapidDetails: { subject, publicKey, privateKey },
          TTL: 12 * 60 * 60, // a phone that's off for the night still gets it in the morning
          urgency: 'normal',
          timeout: 10_000,
        });
        return { ok: true };
      } catch (e) {
        if (e?.statusCode === 404 || e?.statusCode === 410) return { gone: true };
        throw e;
      }
    },
  };
}
