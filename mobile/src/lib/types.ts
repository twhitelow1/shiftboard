// Shapes of what the ShiftBoard API returns (see core/service.js). Only the fields the app uses.

export type Role = 'super_admin' | 'admin' | 'manager' | 'supervisor' | 'employee';

export interface JobCode {
  id: string;
  name: string;
  short?: string;
  color?: string;
  department?: string;
  order?: number;
  archived?: boolean;
}

export interface Person {
  id: string;
  name: string;
  role: Role;
  active?: boolean;
  color?: string;
  order?: number;
  onSchedule?: boolean;
  email?: string;
  phone?: string;
  jobCodes?: { jobCodeId: string; areas?: string[] }[];
}

export interface Me extends Person {
  appearance?: '' | 'auto' | 'light' | 'dark';
  language?: '' | 'en' | 'es';
  emailNotifications?: boolean;
  deletionRequestedAt?: string;
}

export interface Settings {
  restaurantName: string;
  weekStartDow: number;
  closedDays: number[];
  areas?: string[];
  rooms?: string[];
  areaColors?: Record<string, string>;
  startTimesOnly?: boolean;
  requireSwapApproval?: boolean;
  requirePickupApproval?: boolean;
  supervisorsCanApprove?: boolean;
  minSwapNoticeHours?: number;
  openEndHours?: number;
  appearance?: 'auto' | 'light' | 'dark';
  brandColor?: string;
  logoVersion?: number;
}

export interface Boot {
  settings: Settings;
  jobCodes: JobCode[];
  employees: Person[];
  me: Me;
  unread: number;
  pendingApprovals: number;
  openOffers: number;
  today: string;
  /** On the platform (one server for many restaurants): the restaurant's plan features. Absent on a single-restaurant server. */
  tenant?: { slug: string; plan: string; features: Record<string, boolean> } | null;
  /** The schedule's rooms and their positions, in order (Settings → Rooms & positions). Absent on older servers. */
  layout?: Layout;
}

/** The schedule's layout (core/layout.js): rooms in order, each with its positions in order. Staff never get hidden ones. */
export interface Layout {
  rev: number;
  rooms: { room: string; positions: { jobCodeId: string; label?: string; hidden?: boolean }[] }[];
}

export interface Shift {
  id: string;
  date: string;
  start: string;
  end: string | null;
  jobCodeId: string;
  userId: string | null;
  area?: string;
  tag?: string;
  notes?: string;
  published?: boolean;
  eventId?: string | null;
  hours?: number;
  pending?: 'swap' | 'drop' | 'pickup' | null;
}

export interface TimeOff {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  reason?: string;
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
  note?: string;
}

export interface ShiftsList {
  shifts: Shift[];
  timeOff: TimeOff[];
  events: { id: string; name: string; date: string; start: string; room?: string; guestCount?: number }[];
  notes: { id: string; kind: 'day' | 'week'; date: string; text: string }[];
}

export type RequestStatus = 'open' | 'pending_approval' | 'approved' | 'denied' | 'declined' | 'cancelled';

export interface SwapRequest {
  id: string;
  type: 'swap' | 'drop' | 'pickup';
  status: RequestStatus;
  requesterId: string;
  targetUserId?: string;
  pickupUserId?: string;
  note?: string;
  resolution?: string;
  createdAt: string;
  shift: Shift | null;
  targetShift: Shift | null;
  warnings?: string[];
  myConflicts?: string[];
}

export interface SwapsList {
  approvals: SwapRequest[];
  mine: SwapRequest[];
  offers: SwapRequest[];
  history: SwapRequest[];
  openPending: SwapRequest[];
}

export interface AppNotification {
  id: string;
  text: string;
  link?: string;
  read: boolean;
  at: string;
}

// The 86 List (core/eighty-six.js): eightySix.board.get and eightySix.summary.
export interface EightySixItem {
  id: string;
  listId: string;
  name: string;
  nameEs: string;
  menuItemId: string | null;
  status: 'out' | 'low';
  count: number | null;
  note: string;
  area: string;
  reportedBy: { id: string; name: string };
  reportedAt: string;
  updatedBy: { id: string; name: string };
  updatedAt: string;
  photos: { id: string; w: number; h: number; canRemove: boolean }[];
}

export interface EightySixList {
  id: string;
  name: string;
  nameEs: string;
  kind: 'bar' | 'kitchen' | 'other';
  area: string;
  resetAt: string;
  canReport: boolean;
  suggest: string[];
  items: EightySixItem[];
}

export interface EightySixBoard {
  lists: EightySixList[];
  menu: Record<string, { name: string; nameEs: string; category: string }>;
  areas: string[];
  canReport: boolean;
  isMgr: boolean;
  now: string;
}

export interface EightySixSummary {
  lists: { id: string; name: string; nameEs: string; kind: EightySixList['kind']; out: number; low: number }[];
  out: number;
  low: number;
}

/** GET /api/config: what the sign-in screen needs before anyone signs in. */
export interface ServerConfig {
  email: boolean;
  brand: { name: string; color: string; nav?: string; bg?: string; mode?: 'auto' | 'light' | 'dark'; logo: string } | null;
}
