// What the app remembers on the phone, in the phone's secure storage (Keychain / Keystore): the restaurants
// this phone uses (`accounts`), which one is open (`server`), each restaurant's sign-in token (`token.<address>`),
// the push token and the language choice. `token` is where version 1 kept its one token (read once, then moved).
// The "shiftboard." prefix is internal and stays the same if the app is renamed, so nobody gets signed out.
import * as SecureStore from 'expo-secure-store';

export type StoreKey = 'server' | 'token' | 'pushToken' | 'language' | 'accounts' | `token.${string}`;

// SecureStore keys may only hold letters, digits, ".", "-" and "_".
const name = (k: StoreKey) => `shiftboard.${k}`.replace(/[^A-Za-z0-9._-]/g, '_');

export async function getItem(k: StoreKey): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(name(k));
  } catch {
    return null;
  }
}

export async function setItem(k: StoreKey, v: string | null): Promise<void> {
  if (v == null || v === '') await SecureStore.deleteItemAsync(name(k)).catch(() => {});
  else await SecureStore.setItemAsync(name(k), v);
}
