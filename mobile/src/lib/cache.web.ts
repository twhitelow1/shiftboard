// Web preview: the same cache in localStorage (see cache.ts).
export interface Cached<T> { at: string; data: T }

const PREFIX = 'shiftboard.cache.';
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

export async function readCache<T>(key: string): Promise<Cached<T> | null> {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(PREFIX + safe(key)) || 'null');
    return v && typeof v.at === 'string' ? (v as Cached<T>) : null;
  } catch {
    return null;
  }
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  try {
    globalThis.localStorage?.setItem(PREFIX + safe(key), JSON.stringify({ at: new Date().toISOString(), data }));
  } catch {
    /* storage full or private mode */
  }
}

/** Forget everything kept for one restaurant (signing out of it). */
export async function clearCache(prefix: string): Promise<void> {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return;
    const start = PREFIX + safe(prefix);
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k?.startsWith(start)) keys.push(k);
    }
    keys.forEach((k) => ls.removeItem(k));
  } catch {
    /* nothing to clear */
  }
}
