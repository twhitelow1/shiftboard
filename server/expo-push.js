// Native app push notifications through the Expo Push API (https://exp.host).
//
// The ShiftBoard phone app (mobile/) registers its Expo push token with the RPC
// devices.register, which stores { userId, token, platform, createdAt } in the
// deviceTokens collection. After a write commits, every new in-app notification is
// also pushed to the recipient's phones (see onCommit in server/app.js).
//
// Nothing to set up on the server: Expo holds the Apple (APNs) and Google (FCM v1)
// credentials for the app. Optional env:
//   EXPO_ACCESS_TOKEN  only if "enhanced push security" is turned on for the Expo project
//   EXPO_PUSH=off      turn native push off
//
// Expo answers each message with a ticket. A ticket or a later receipt that says
// DeviceNotRegistered means the app was removed from that phone: the token is deleted.
// Receipts are ready some minutes after sending, so each send also checks the receipts
// of earlier sends that are old enough (kept briefly in the pushTickets collection).

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const SEND_BATCH = 100; // Expo's limit per send request
const RECEIPT_BATCH = 1000; // Expo's limit per receipts request
const RECEIPT_WAIT_MS = 15 * 60 * 1000; // check a ticket's receipt after this long
const RECEIPT_GIVE_UP_MS = 24 * 60 * 60 * 1000; // Expo keeps receipts for about a day

/** True for an Expo push token, e.g. ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]. */
export const isExpoPushToken = (t) => typeof t === 'string' && t.length <= 200 && /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/.test(t);

export function createExpoPush(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const enabled = env.EXPO_PUSH !== 'off';
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
  };

  async function post(url, body) {
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Expo push ${res.status}: ${data.errors?.[0]?.message || 'request failed'}`);
    return data;
  }

  return {
    enabled,
    /**
     * Send messages ({ to, title, body, data, ... }) in batches of 100.
     * Returns { tickets: [{ id, token }], unregistered: [token] }.
     */
    async send(messages) {
      const tickets = [];
      const unregistered = [];
      if (!enabled) return { tickets, unregistered };
      for (let i = 0; i < messages.length; i += SEND_BATCH) {
        const chunk = messages.slice(i, i + SEND_BATCH);
        const { data = [] } = await post(EXPO_PUSH_URL, chunk);
        chunk.forEach((m, k) => {
          const t = data[k];
          if (t?.status === 'ok' && t.id) tickets.push({ id: t.id, token: m.to });
          else if (t?.details?.error === 'DeviceNotRegistered') unregistered.push(m.to);
          else if (t?.status === 'error') console.error('Expo push ticket error:', t.details?.error || t.message);
        });
      }
      return { tickets, unregistered };
    },
    /** Look up receipts for ticket ids. Returns { checked: [id], unregistered: [id] }. */
    async receipts(ids) {
      const checked = [];
      const unregistered = [];
      if (!enabled) return { checked, unregistered };
      for (let i = 0; i < ids.length; i += RECEIPT_BATCH) {
        const { data = {} } = await post(EXPO_RECEIPTS_URL, { ids: ids.slice(i, i + RECEIPT_BATCH) });
        for (const [id, r] of Object.entries(data)) {
          checked.push(id);
          if (r?.details?.error === 'DeviceNotRegistered') unregistered.push(id);
          else if (r?.status === 'error') console.error('Expo push receipt error:', r.details?.error || r.message);
        }
      }
      return { checked, unregistered };
    },
  };
}

/**
 * One push message per registered phone for each new in-app notification in a commit.
 * Skips inactive people, and phones registered under an older session (a password
 * change or reset signs every phone out, so they stop getting pushes too).
 */
export function pushMessages(changes, store, { title = 'ShiftBoard' } = {}) {
  const notes = changes.filter((c) => c.col === 'notifications' && c.isNew && c.doc).map((c) => c.doc);
  if (!notes.length) return [];
  const devices = store.list('deviceTokens');
  if (!devices.length) return [];
  const unread = {};
  for (const n of store.list('notifications', (x) => !x.read)) unread[n.userId] = (unread[n.userId] || 0) + 1;
  const messages = [];
  for (const n of notes) {
    const u = store.get('users', n.userId);
    if (!u || u.active === false) continue;
    for (const d of devices) {
      if (d.userId !== u.id || (d.v || 0) !== (u.sessionVersion || 0)) continue;
      messages.push({
        to: d.token, title, body: n.text, sound: 'default', priority: 'high', channelId: 'default',
        badge: unread[u.id] || 0, data: { link: n.link || '', notificationId: n.id },
      });
    }
  }
  return messages;
}

/**
 * Push a commit's new notifications, then tidy up: delete tokens Expo says are gone, and
 * check the receipts of earlier sends. Meant to run in the background after the response.
 * @param {{ changes: object[], db: import('./db.js').DocDb, push: ReturnType<typeof createExpoPush>, title?: string, now?: () => number }} opts
 */
export async function pushNotifications({ changes, db, push, title, now = Date.now }) {
  if (!push.enabled) return { sent: 0 };
  const messages = pushMessages(changes, db.store, { title });
  if (!messages.length) return { sent: 0 };
  const { tickets, unregistered } = await push.send(messages);

  // Receipts of earlier sends that are old enough to check (or too old to bother with).
  const t = now();
  const waiting = db.store.list('pushTickets', (x) => t - Date.parse(x.at) >= RECEIPT_WAIT_MS);
  const stale = waiting.filter((x) => t - Date.parse(x.at) >= RECEIPT_GIVE_UP_MS).map((x) => x.id);
  const toCheck = waiting.filter((x) => !stale.includes(x.id));
  let receipts = { checked: [], unregistered: [] };
  if (toCheck.length) {
    try { receipts = await push.receipts(toCheck.map((x) => x.id)); } catch (e) { console.error('Expo push receipts failed:', e.message); }
  }
  const tokenOf = Object.fromEntries(toCheck.map((x) => [x.id, x.token]));
  const gone = new Set([...unregistered, ...receipts.unregistered.map((id) => tokenOf[id])].filter(Boolean));
  const done = new Set([...stale, ...receipts.checked]);

  if (!tickets.length && !done.size && !gone.size) return { sent: messages.length, removed: 0 };
  const at = new Date(t).toISOString();
  await db.run((s) => {
    for (const k of tickets) s.insert('pushTickets', { id: k.id, token: k.token, at });
    for (const id of done) s.remove('pushTickets', id);
    for (const d of s.list('deviceTokens', (x) => gone.has(x.token))) s.remove('deviceTokens', d.id);
  }, { write: true });
  return { sent: messages.length, removed: gone.size };
}
