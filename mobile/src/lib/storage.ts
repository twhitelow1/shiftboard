// What the app remembers on the phone, in the phone's secure storage (Keychain / Keystore):
// the restaurant address, the sign-in token, the push token and the language choice.
import * as SecureStore from 'expo-secure-store';

export type StoreKey = 'server' | 'token' | 'pushToken' | 'language';

const name = (k: StoreKey) => `shiftboard.${k}`;

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
