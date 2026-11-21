// Phone notifications in the browser (hosted app only): the service worker at /sw.js, signing
// this phone up with the server's key, and what an iPhone needs first.

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// iPads report themselves as Macs; a Mac with a touch screen is an iPad.
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => !!(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone);

let registering = null;
/** Register /sw.js once. It caches nothing; it only shows notifications. */
export function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve(null);
  registering ??= navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => {
    registering = null;
    console.warn('Service worker not registered:', e.message);
    return null;
  });
  return registering;
}

/** At startup: register after the page has loaded, and follow taps on notifications while the app is open. */
export function startServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  if (document.readyState === 'complete') registerServiceWorker();
  else window.addEventListener('load', () => registerServiceWorker(), { once: true });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'shiftboard:open') return;
    try {
      const u = new URL(e.data.url);
      if (u.origin === location.origin) location.hash = u.hash || '#/';
    } catch { /* ignore */ }
  });
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('Timed out')), ms))]);

/** The service worker registration once it's active (so a tap can subscribe right away), or null. */
export async function readyRegistration() {
  if (!pushSupported()) return null;
  if (!(await registerServiceWorker())) return null;
  return withTimeout(navigator.serviceWorker.ready, 10_000).catch(() => null);
}

/** This phone's subscription, or null. */
export async function currentSubscription(reg) {
  try { return reg ? await reg.pushManager.getSubscription() : null; } catch { return null; }
}

const keyBytes = (b64) => {
  const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};

/**
 * Sign this phone up (asks for permission if needed). Call it first thing in the tap's handler:
 * iPhones only show the permission question for a tap. Returns the subscription as JSON.
 */
export async function subscribePhone(reg, publicKey) {
  const options = { userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) };
  // With no permission question on screen, a phone that can't reach its push service gives up after 30s.
  const limit = (p) => (Notification.permission === 'granted'
    ? withTimeout(p, 30_000).catch((e) => { throw e.message === 'Timed out' ? new Error('Couldn’t reach this phone’s notification service. Check the connection and try again.') : e; })
    : p);
  try {
    return (await limit(reg.pushManager.subscribe(options))).toJSON();
  } catch (e) {
    // Signed up before with other keys (the restaurant changed them): start over.
    const old = await currentSubscription(reg);
    if (!old) throw e;
    await old.unsubscribe();
    return (await limit(reg.pushManager.subscribe(options))).toJSON();
  }
}

/** Signing out: stop this person's notifications on this phone. Never blocks sign-out for long. */
export async function forgetThisDevice(call) {
  try {
    if (!pushSupported()) return;
    const reg = await withTimeout(navigator.serviceWorker.getRegistration('/'), 1500);
    const sub = await currentSubscription(reg);
    if (!sub) return;
    await withTimeout(call('push.unsubscribe', { endpoint: sub.endpoint }), 2500).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  } catch { /* sign out anyway */ }
}
