// Web preview: no push notifications (the website has its own notifications).
import type { Client } from './api';

export type PushStatus = 'on' | 'off' | 'ask' | 'unavailable';
export const pushSupported = () => false;
export const easProjectId = (): string | null => null;
export function setChannelName(_name: string) {}
export const pushStatus = async (): Promise<PushStatus> => 'unavailable';
export const registerForPush = async (_client: Client): Promise<string | null> => null;
export const unregisterPush = async (_client: Client): Promise<void> => {};
export const onPushReceived = (_cb: () => void): (() => void) => () => {};
export const useTappedNotificationLink = (): { id: string; link: string; title: string } | null => null;
export const setBadge = (_n: number) => Promise.resolve();
