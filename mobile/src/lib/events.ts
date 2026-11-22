// Events / BEOs: status colors and the service styles (core/beo.js SERVICE_STYLES keys; their names are in the
// i18n catalogs under events.style).
import type { Tone } from '@/components/ui';

export const STATUSES = ['tentative', 'confirmed', 'completed', 'cancelled'] as const;
export type EventStatus = (typeof STATUSES)[number];
export const STATUS_TONE: Record<EventStatus, Tone> = { tentative: 'warn', confirmed: 'ok', completed: 'neutral', cancelled: 'bad' };
export const isStatus = (s: string | undefined): s is EventStatus => (STATUSES as readonly string[]).includes(s || '');

export const SERVICE_STYLES = ['plated', 'family', 'buffet', 'stations', 'reception', 'cocktail'] as const;
export type ServiceStyle = (typeof SERVICE_STYLES)[number];
export const isStyle = (s: string | undefined): s is ServiceStyle => (SERVICE_STYLES as readonly string[]).includes(s || '');
