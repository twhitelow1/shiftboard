// The bottom tabs, in order. New areas of the app slot in here: the Training portal (menu study
// guide, quizzes, employee manual, manager on duty) gets a tab when it ships. Until then it is a
// "Coming soon" row in More (src/app/(app)/training.tsx). The 86 List (src/app/(app)/eighty-six.tsx) is the
// first row in More, since a sixth tab doesn't fit at 360 px, and a banner on My Shifts when something's out.
import type { IconName } from '@/components/Icon';
import type { MsgKey } from '@/i18n';
import type { Boot } from '@/lib/types';

export interface TabDef {
  /** The file in src/app/(app)/(tabs)/ */
  name: string;
  title: MsgKey;
  icon: IconName;
  badge?: (boot: Boot, canApprove: boolean) => number;
}

export const TABS: TabDef[] = [
  { name: 'shifts', title: 'tabs.shifts', icon: 'calendar' },
  { name: 'schedule', title: 'tabs.schedule', icon: 'grid' },
  { name: 'swaps', title: 'tabs.swaps', icon: 'swap', badge: (b) => b.openOffers || 0 },
  { name: 'time-off', title: 'tabs.timeOff', icon: 'sun' },
  // { name: 'training', title: 'tabs.training', icon: 'book' },  ← when the Training portal is ready
  { name: 'more', title: 'tabs.more', icon: 'more' },
];
