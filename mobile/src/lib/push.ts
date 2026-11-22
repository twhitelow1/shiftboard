// Push notifications on the phone. After sign-in the app asks for permission, gets this phone's
// Expo push token and registers it with the server (devices.register). The server sends through
// the Expo Push API whenever it creates an in-app notification for this person (server/expo-push.js).
//
// Needs an EAS project id (set by `eas init`) and a development or store build: Expo Go on
// Android can't receive push since SDK 53. See docs/mobile-app/DEVELOPING.md.
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { isRunningInExpoGo } from 'expo';
import { Platform } from 'react-native';

import type { Client } from './api';
import { getItem, setItem } from './storage';

// Show notifications that arrive while the app is open, too.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }),
});

export const pushSupported = () => Device.isDevice && !(Platform.OS === 'android' && isRunningInExpoGo());

export function easProjectId(): string | null {
  return (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;
}

let channelName = 'Schedule and trades';
/** The Android notification channel's name, in the person's language. */
export function setChannelName(name: string) {
  channelName = name;
}

export type PushStatus = 'on' | 'off' | 'ask' | 'unavailable';

export async function pushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return 'unavailable';
  const { status } = await Notifications.getPermissionsAsync();
  return status === 'granted' ? 'on' : status === 'undetermined' ? 'ask' : 'off';
}

/** Ask for permission (once), then register this phone for the signed-in person. Returns the token or null. */
export async function registerForPush(client: Client): Promise<string | null> {
  if (!pushSupported()) return null;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: channelName, importance: Notifications.AndroidImportance.HIGH });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status === 'undetermined') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null;
  const projectId = easProjectId();
  if (!projectId) {
    console.warn('Push is off: no EAS project id yet. Run `npx eas-cli init` in mobile/.');
    return null;
  }
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  await client.call('devices.register', { token, platform: Platform.OS });
  await setItem('pushToken', token);
  return token;
}

/** Signing out: stop pushes to this phone for this person. */
export async function unregisterPush(client: Client): Promise<void> {
  const token = await getItem('pushToken');
  if (token) await client.call('devices.unregister', { token });
  await Notifications.setBadgeCountAsync(0).catch(() => {});
}

/** Run cb when a notification arrives while the app is open. Returns an unsubscribe function. */
export function onPushReceived(cb: () => void): () => void {
  const sub = Notifications.addNotificationReceivedListener(() => cb());
  return () => sub.remove();
}

/**
 * The notification the person tapped to open the app, if any: its link, and its title (the restaurant's name,
 * which picks the restaurant when the phone has more than one).
 */
export function useTappedNotificationLink(): { id: string; link: string; title: string } | null {
  const r = Notifications.useLastNotificationResponse();
  if (!r || r.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return null;
  const content = r.notification.request.content;
  const data = content.data as { link?: string } | undefined;
  return { id: r.notification.request.identifier, link: data?.link || '', title: content.title || '' };
}

export const setBadge = (n: number) => Notifications.setBadgeCountAsync(n).catch(() => {});
