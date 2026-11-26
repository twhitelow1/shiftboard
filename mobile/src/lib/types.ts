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

/** One weekday's availability (0 = Sunday): any time, some hours (from/to), or unavailable. */
export interface DayAvailability { available?: boolean; from?: string; to?: string }

export interface Me extends Person {
  availability?: Record<string, DayAvailability>;
  eventsAccess?: boolean;
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
  /** Settings → Branding: the website's sidebar color (the app's header) and the light-mode background. */
  navColor?: string;
  bgColor?: string;
  logoVersion?: number;
  hours?: Record<string, { open?: string; close?: string }>;
  departments?: string[];
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
  /** Plan features on the multi-restaurant platform (see lib/features.ts); absent = everything on. */
  features?: Record<string, boolean>;
  tenant?: { slug?: string; plan?: string; status?: string; features?: Record<string, boolean>; billing?: { kind: 'trial' | 'pastDue'; daysLeft?: number; endsAt?: string } | null } | null;
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
  staffingLineId?: string | null;
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
  events: { id: string; name: string; date: string; start: string; end?: string; room?: string; guestCount?: number; status?: string }[];
  notes: { id: string; kind: 'day' | 'week'; date: string; text: string }[];
  /** Managers only: conflicts per shift id. */
  warnings?: Record<string, string[]>;
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
  /** Menu items out (86'd) today on lists the person can see: Training's badge. */
  outMenuItemIds?: string[];
}

/** GET /api/config: what the sign-in screen needs before anyone signs in. */
export interface ServerConfig {
  email: boolean;
  brand: { name: string; color: string; nav?: string; bg?: string; mode?: 'auto' | 'light' | 'dark'; logo: string } | null;
  /** Multi-restaurant platform: the restaurant's plan features, and whether its account is paused. */
  features?: Record<string, boolean>;
  paused?: boolean;
}

// ---------- Training (core/training.js) ----------
export interface MenuEs {
  name?: string; description?: string; keyIngredients?: string[];
  selling?: { notes?: string; pairings?: string };
  recipe?: { yield?: string; ingredients?: { qty: string; item: string }[]; steps?: string[] };
  prep?: { notes?: string };
}
export interface MenuItem {
  id: string; name: string; category: string; description: string; price: number | null;
  keyIngredients: string[]; allergens: string[]; dietary: string[]; eightySixed: boolean;
  photos: { id: string; w: number; h: number }[]; order: number;
  can: { selling: boolean; recipe: boolean; prep: boolean };
  es?: MenuEs;
  /** Only when the server sends them: the viewer may see these groups. */
  selling?: { notes: string; pairings: string };
  recipe?: { yield: string; ingredients: { qty: string; item: string }[]; steps: string[] };
  prep?: { notes: string };
}
export interface MenuList {
  items: MenuItem[];
  categories: string[];
  categoryEs: Record<string, string>;
  allergens: { id: string; label: string; es: string; custom?: boolean }[];
  dietary: string[];
}
export interface QuizRow {
  id: string; title: string; description: string; es?: { title?: string; description?: string };
  count: number; passingScore: number | null; dueDate: string | null; feedback: 'each' | 'end';
  active: boolean; assigned: boolean;
  my: { attempts: number; best: number | null; passed: boolean; lastAt: string | null; openAttemptId: string | null };
}
export interface AttemptQuestion {
  key: string; type: string; prompt: string; photo: boolean; choices: { id: string; text: string }[]; answerId: string | null;
  /** Only once the answer can be shown (after answering in "each" mode, or after handing in). */
  correctId?: string; correct?: boolean; explain?: string; itemId?: string | null; itemName?: string;
}
export interface Attempt {
  id: string; quizId: string; title: string; feedback: 'each' | 'end'; passingScore: number | null; userId: string;
  startedAt: string; submittedAt: string | null; total: number; score?: number; pct?: number; passed?: boolean;
  questions: AttemptQuestion[];
}
export interface AttemptSummary { id: string; quizId: string; title: string; submittedAt: string; score: number; total: number; pct: number; passed: boolean }
export interface BoardStats { attempts: number; best: number | null; avg: number | null; passed: number; mastered: number; answered: number; correct: number }
export interface BoardRow extends BoardStats { userId: string; name: string; color: string | null; positions: string[]; rank: number | null }
export interface Leaderboard {
  visible: boolean; rows?: BoardRow[]; me: BoardRow; sort: string; mastery: { answers: number; pct: number };
}
export interface ManualPageInfo {
  id: string; sectionId: string; title: string; isCallOut: boolean; updatedAt: string; updatedBy: string;
  version: number; my: { ackedAt: string | null; current: boolean }; es: { title: string; body?: string }; body?: string;
}
export interface ManualList { sections: { id: string; title: string; es: { title: string }; pages: ManualPageInfo[] }[] }
export interface ManualPage extends ManualPageInfo { body: string; sectionTitle: string; sectionEs: string }
export interface ModInfo {
  date: string;
  status: 'now' | 'next' | 'planned' | 'override' | 'none';
  callOutPhone: string;
  person: { id: string; name: string; phone: string; shift: { date: string; start: string; end: string | null; estimatedEnd: boolean; jobName: string } | null } | null;
  alsoOn: { id: string; name: string }[];
  /** Every manager on the schedule that day: on now first, then later today, then earlier (core/training.js). */
  managers?: ModManager[];
}
export interface ModManager {
  id: string; name: string; phone: string;
  shift: { date: string; start: string; end: string | null; estimatedEnd: boolean; jobName: string } | null;
  state: 'now' | 'later' | 'earlier' | 'planned';
  inCharge: boolean;
}
export interface TrainingSummary {
  quizzes: { id: string; title: string; dueDate: string | null; overdue: boolean }[];
  pages: { id: string; title: string }[];
}

// ---------- My tips (core/tips.js myTips.week) ----------
export interface MyTipsItem {
  poolId: string; poolName: string; method: string; period: 'day' | 'week'; start: string; end: string; label: string;
  poolTotal: number; toSplit: number; totalPoints: number; workers: number;
  me: { minutes: number; shifts: number; points: number; sharePct: number; source: string; estimated: boolean; split: number; adjustment: number; amount: number };
  lines: string[];
}
export interface MyTipsWeek {
  weekStart: string; end: string; label: string; final: boolean; finalAt: string | null; total: number;
  items: MyTipsItem[]; waiting: string[]; pools: { id: string; name: string; rules: string[] }[];
}

// ---------- Venue: rooms, floor plans and server sections (core/venue-links.js) ----------
export interface PlanItem { id: string; type: string; x: number; y: number; w: number; h: number; r: number; label: string; seats: number; zone?: string; toastGuid?: string }
export interface Room { id: string; name: string; level?: string; locationId?: string; plan?: { width: number; height: number; items: PlanItem[] } }
export interface SectionEntry {
  shiftId: string; userId: string | null; jobCodeId: string; start: string; end: string | null; published: boolean;
  eventId: string | null; tableIds: string[]; tables: string[]; seats: number;
}
export interface SectionDay { id: string; roomId: string; roomName: string; date: string; entries: SectionEntry[] }

// ---------- Events / BEOs (core/service.js events.*) ----------
export interface EventRow {
  id: string; name: string; date: string; start: string; end?: string; room?: string; guestCount?: number; status: string;
  type?: string; needed: number; filled: number; captainId?: string | null;
}
export interface EventDetail extends EventRow {
  guaranteed?: number | string; serviceStyle?: string; client?: string; attire?: string;
  /** Only the events team gets these from the server; the app shows them only to the events team. */
  contactName?: string; contactPhone?: string; contactEmail?: string;
  menu?: { course: string; item: string; notes?: string }[];
  beverage?: { package?: string; bar?: string; notes?: string };
  specialDrinks?: { name: string; recipe?: string; batch?: string }[];
  timeline?: { time: string; item: string }[];
  setupNotes?: string; dietaryNotes?: string; avNotes?: string; notes?: string;
  staffing: { id: string; jobCodeId: string; count: number; start?: string; notes?: string; created: number; filled: number }[];
  shifts: Shift[];
  comments?: { id: string; userId: string; userName: string; text: string; at: string }[];
}

/** forecast.covers: projected covers per day (everyone may see them, like the house sheet). */
export interface CoversWeek { days: { date: string; totalCovers: number; closed?: boolean }[] }
