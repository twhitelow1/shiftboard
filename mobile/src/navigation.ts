// The bottom tabs, in order. Five fit at 360 px in both languages, so the fourth tab depends on the restaurant's
// plan: Training when it's included (Time Off then lives in My Shifts and More, as a screen with a back button),
// Time Off otherwise. Tabs for features the plan doesn't include are hidden (lib/features.ts).
// The 86 List, my tips, events, availability and the floor tools are rows in More.
import type { IconName } from '@/components/Icon';
import type { MsgKey } from '@/i18n';
import type { Feature } from '@/lib/features';
import type { Boot } from '@/lib/types';

export interface TabDef {
  /** The file in src/app/(app)/(tabs)/ */
  name: string;
  title: MsgKey;
  icon: IconName;
  badge?: (boot: Boot, canApprove: boolean) => number;
  /** Shown only when this returns true (default: always). */
  shown?: (has: (f: Feature) => boolean) => boolean;
}

/** Time Off is a tab only when Training isn't. */
export const showTimeOffTab = (has: (f: Feature) => boolean) => !has('training');

export const TABS: TabDef[] = [
  { name: 'shifts', title: 'tabs.shifts', icon: 'calendar' },
  { name: 'schedule', title: 'tabs.schedule', icon: 'grid' },
  { name: 'swaps', title: 'tabs.swaps', icon: 'swap', badge: (b) => b.openOffers || 0 },
  { name: 'time-off', title: 'tabs.timeOff', icon: 'sun', shown: showTimeOffTab },
  { name: 'training', title: 'tabs.training', icon: 'book', shown: (has) => has('training') },
  { name: 'more', title: 'tabs.more', icon: 'more', badge: (b, canApprove) => (canApprove ? b.pendingApprovals || 0 : 0) },
];
