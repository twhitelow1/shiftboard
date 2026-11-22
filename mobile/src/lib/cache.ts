// The last data some screens showed, kept on the phone (a small JSON file per entry in the app's documents
// folder) so My Shifts, the schedule and the restaurant's basics still show when there's no signal, with a
// "last updated" note. Keys are per restaurant and person (see cacheKey in session.tsx). No tokens or secrets.
import { Directory, File, Paths } from 'expo-file-system';

export interface Cached<T> { at: string; data: T }

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
const dir = () => new Directory(Paths.document, 'cache');
const fileFor = (key: string) => new File(dir(), `${safe(key).slice(0, 180)}.json`);

export async function readCache<T>(key: string): Promise<Cached<T> | null> {
  try {
    const f = fileFor(key);
    if (!f.exists) return null;
    const v = JSON.parse(await f.text());
    return v && typeof v.at === 'string' ? (v as Cached<T>) : null;
  } catch {
    return null;
  }
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  try {
    const d = dir();
    if (!d.exists) d.create({ intermediates: true, idempotent: true });
    const f = fileFor(key);
    if (!f.exists) f.create();
    await f.write(JSON.stringify({ at: new Date().toISOString(), data }));
  } catch {
    /* a full disk: the app just won't have it offline */
  }
}

/** Forget everything kept for one restaurant (signing out of it). */
export async function clearCache(prefix: string): Promise<void> {
  try {
    const d = dir();
    if (!d.exists) return;
    const p = safe(prefix);
    for (const f of d.list()) if (f instanceof File && f.name.startsWith(p)) f.delete();
  } catch {
    /* nothing to clear */
  }
}
