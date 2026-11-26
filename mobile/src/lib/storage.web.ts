// Web preview only (npx expo start --web / expo export --platform web): SecureStore isn't
// available in browsers, so the web build keeps the same values in localStorage.
export type StoreKey = 'server' | 'token' | 'pushToken' | 'language' | 'accounts' | `token.${string}` | `daySort.${string}`;

const name = (k: StoreKey) => `shiftboard.${k}`.replace(/[^A-Za-z0-9._-]/g, '_');

export async function getItem(k: StoreKey): Promise<string | null> {
  try {
    return globalThis.localStorage?.getItem(name(k)) ?? null;
  } catch {
    return null;
  }
}

export async function setItem(k: StoreKey, v: string | null): Promise<void> {
  try {
    if (v == null || v === '') globalThis.localStorage?.removeItem(name(k));
    else globalThis.localStorage?.setItem(name(k), v);
  } catch {
    /* private mode: nothing is remembered */
  }
}
