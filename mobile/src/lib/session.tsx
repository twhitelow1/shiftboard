// The app's state: the restaurants this phone uses (someone may work at two), which one is open, its sign-in,
// and the restaurant's data every screen needs (app.bootstrap: settings, positions, people, me, plan features).
//
// Each restaurant keeps its own session token (secure storage, `token.<address>`), so switching between them in
// More doesn't sign anyone out, and push notifications keep coming from all of them. The last bootstrap is kept
// on the phone (lib/cache.ts) so the app opens with no signal, saying when the data is from.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, useColorScheme } from 'react-native';

import { useI18n } from '@/i18n';
import { ApiError, createClient, fetchConfig, login, verifySignIn, type Client, type LoginStep } from './api';
import { clearCache, readCache, writeCache } from './cache';
import { featureOn, featuresOf, type Feature, type Features } from './features';
import { registerForPush, unregisterPush, onPushReceived } from './push';
import { hostedServer } from './hosted';
import { getItem, setItem } from './storage';
import { brandFrom, isDark, palette, type Brand, type Palette } from './theme';
import { todayStr } from './time';
import type { Boot, JobCode, Person, ServerConfig } from './types';

/** A restaurant this phone has opened. The token lives apart, in secure storage. */
export interface Account {
  server: string;
  /** What we knew last: the restaurant's name, color and logo path, and who's signed in there. */
  name?: string;
  color?: string;
  logo?: string;
  /**
   * The restaurant's Branding last seen (and the person's own appearance), so the app opens in its colors
   * before the restaurant's data has loaded. Replaced every time fresh data comes in.
   */
  brand?: Brand;
  userName?: string;
  signedIn?: boolean;
}

interface Session {
  /** Saved values have been read from the phone. */
  ready: boolean;
  accounts: Account[];
  server: string | null;
  config: ServerConfig | null;
  token: string | null;
  boot: Boot | null;
  bootError: ApiError | null;
  /** When the restaurant's data on screen is the copy kept on the phone (no connection): when it was saved. */
  offlineSince: string | null;
  /** The last session ended on its own (expired, or signed out by a password change). */
  expired: boolean;
  client: Client;
  /** Goes up whenever data changed; screens reload when it does. */
  version: number;
  colors: Palette;
  logoUrl: string | null;
  jobs: Record<string, JobCode>;
  people: Record<string, Person>;
  /** Shift leads (if allowed) and managers: approve trades and time off. */
  canApprove: boolean;
  /** Managers and up: drafts, publishing. */
  isMgr: boolean;
  /** The events team (managers, or people with events access): the whole BEO, client contact included. */
  isEvents: boolean;
  /** Supervisors and up: the floor tools (who's working now, approvals). */
  isLead: boolean;
  features: Features;
  /** Is a plan feature on for this restaurant? (Everything is, unless the server says otherwise.) */
  has: (f: Feature) => boolean;
  /** Where this restaurant's copies of data are kept on the phone (lib/cache.ts keys start with it). */
  cachePrefix: string;
  /** Open a restaurant: add it to the list if it's new and make it the current one. */
  openRestaurant: (origin: string, config?: ServerConfig | null) => Promise<void>;
  /** Leave the current restaurant open in the background and show the address screen to add another. */
  startAdding: () => void;
  /** Sign out of a restaurant and remove it from this phone. */
  forget: (origin: string) => Promise<void>;
  /**
   * Sign in with email and password. Signed in right away on servers without two-step sign-in ('token');
   * otherwise the next step: enter a code ('verify') or finish setting up the account ('enroll').
   */
  signIn: (email: string, password: string) => Promise<LoginStep>;
  /** Step two: a code from the authenticator app ('totp') or a recovery code. */
  verifyCode: (ticket: string, method: 'totp' | 'recovery', code: string) => Promise<void>;
  /** Keep a session token the server handed over (after setting up an authenticator app in the app). */
  acceptToken: (token: string) => void;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  bump: () => void;
}

const Ctx = createContext<Session | null>(null);
const RANK: Record<string, number> = { super_admin: 5, admin: 4, manager: 3, supervisor: 2, employee: 1 };
const tokenKey = (server: string) => `token.${server}` as const;

export function SessionProvider({ children }: { children: ReactNode }) {
  const i18n = useI18n();
  const scheme = useColorScheme();
  const [ready, setReady] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [server, setServerState] = useState<string | null>(null);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [boot, setBoot] = useState<Boot | null>(null);
  const [bootError, setBootError] = useState<ApiError | null>(null);
  const [offlineSince, setOfflineSince] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [version, setVersion] = useState(0);
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;
  const serverRef = useRef<string | null>(null);
  serverRef.current = server;
  const accountsRef = useRef<Account[]>([]);

  const saveAccounts = useCallback((next: Account[]) => {
    accountsRef.current = next;
    setAccounts(next);
    setItem('accounts', JSON.stringify(next)).catch(() => {});
  }, []);
  const patchAccount = useCallback((origin: string, patch: Partial<Account>) => {
    const list = accountsRef.current;
    const i = list.findIndex((a) => a.server === origin);
    const next = i < 0 ? [...list, { server: origin, ...patch }] : list.map((a, k) => (k === i ? { ...a, ...patch } : a));
    if (JSON.stringify(next) !== JSON.stringify(list)) saveAccounts(next);
  }, [saveAccounts]);

  /** The current restaurant's token, in memory and on the phone. */
  const saveToken = useCallback((t: string | null) => {
    tokenRef.current = t;
    setToken(t);
    const s = serverRef.current;
    if (s) {
      setItem(tokenKey(s), t).catch(() => {});
      patchAccount(s, { signedIn: !!t });
    }
  }, [patchAccount]);

  const clientRef = useRef<Client | null>(null);
  const client = useMemo(() => createClient(server || '', () => tokenRef.current, {
    onUnauthorized: () => {
      if (!tokenRef.current) return;
      saveToken(null);
      setBoot(null);
      setExpired(true);
    },
    onToken: (t) => {
      saveToken(t);
      registerForPush(clientRef.current!).catch(() => {}); // the phone's push registration follows the new session
    },
  }), [server, saveToken]);
  clientRef.current = client;

  // Read what's saved on the phone. Version 1 kept one restaurant and one token: move them into the list.
  useEffect(() => {
    (async () => {
      const [saved, raw, old] = await Promise.all([getItem('server'), getItem('accounts'), getItem('token')]);
      const s = saved || hostedServer(); // the browser version at <restaurant>/app: that restaurant
      let list: Account[] = [];
      try { list = (JSON.parse(raw || '[]') as Account[]).filter((a) => a && typeof a.server === 'string'); } catch { list = []; }
      if (s && !list.some((a) => a.server === s)) list.push({ server: s });
      if (s && old) {
        if (!(await getItem(tokenKey(s)))) await setItem(tokenKey(s), old);
        await setItem('token', null);
      }
      const t = s ? await getItem(tokenKey(s)) : null;
      accountsRef.current = list;
      setAccounts(list);
      serverRef.current = s;
      setServerState(s);
      tokenRef.current = t;
      setToken(t);
      setReady(true);
      if (s && !t) fetchConfig(s).then(setConfig).catch(() => {}); // signed in: refresh() fetches it with the data
    })();
  }, []);

  const refresh = useCallback(async () => {
    const s = serverRef.current;
    if (!s || !tokenRef.current) return;
    // The sign-in page's Branding and the plan's features too, so neither stays as it was when the app opened.
    fetchConfig(s).then((c) => { if (serverRef.current === s) setConfig(c); }).catch(() => {});
    try {
      const b = await client.call<Boot>('app.bootstrap');
      if (serverRef.current !== s) return; // switched restaurants meanwhile
      setBoot(b);
      setBootError(null);
      setOfflineSince(null);
      writeCache(`${s}|boot`, b);
      patchAccount(s, { name: b.settings.restaurantName, userName: b.me.name, signedIn: true });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status === 401 || serverRef.current !== s) return;
      setBootError(e);
      // No connection: open with the copy from last time, saying when it's from.
      if (e.code === 'network') {
        const cached = await readCache<Boot>(`${s}|boot`);
        if (cached && serverRef.current === s) {
          setBoot((cur) => cur || { ...cached.data, today: [cached.data.today, todayStr()].sort().pop()! });
          setOfflineSince(cached.at);
        }
      }
    }
  }, [client, patchAccount]);

  // Signed in: load the restaurant's data, then ask for notifications and register this phone.
  useEffect(() => {
    if (!ready || !token || !server) return;
    refresh();
  }, [ready, token, server, refresh]);
  const signedInUser = boot?.me.id;
  useEffect(() => {
    if (signedInUser && !offlineSince) registerForPush(client).catch(() => {});
  }, [signedInUser, client]); // eslint-disable-line react-hooks/exhaustive-deps

  // The language: adopt the one saved on the server if this phone hasn't picked one; save the person's choice there.
  useEffect(() => {
    const l = boot?.me.language;
    if ((l === 'en' || l === 'es') && !i18n.chosen) i18n.setLang(l, { sync: false });
  }, [boot?.me.language]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (i18n.changes && tokenRef.current) client.call('account.preferences', { language: i18n.chosen ?? '' }).catch(() => {});
  }, [i18n.changes]); // eslint-disable-line react-hooks/exhaustive-deps

  const bump = useCallback(() => {
    setVersion((v) => v + 1);
    refresh();
  }, [refresh]);

  // Back in the app, or a notification arrived: refresh.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active' && tokenRef.current) bump(); });
    const off = onPushReceived(() => bump());
    return () => { sub.remove(); off(); };
  }, [bump]);

  const openRestaurant = useCallback(async (origin: string, cfg: ServerConfig | null = null) => {
    const t = await getItem(tokenKey(origin));
    patchAccount(origin, { ...(cfg?.brand?.name ? { name: cfg.brand.name, color: cfg.brand.color || undefined, logo: cfg.brand.logo || undefined } : {}), signedIn: !!t });
    serverRef.current = origin;
    tokenRef.current = t;
    setBoot(null);
    setBootError(null);
    setOfflineSince(null);
    setExpired(false);
    setServerState(origin);
    setToken(t);
    setConfig(cfg);
    setVersion((v) => v + 1);
    await setItem('server', origin);
    if (!cfg) fetchConfig(origin).then((c) => { if (serverRef.current === origin) setConfig(c); }).catch(() => {});
  }, [patchAccount]);

  const startAdding = useCallback(() => {
    serverRef.current = null;
    tokenRef.current = null;
    setServerState(null);
    setToken(null);
    setBoot(null);
    setBootError(null);
    setOfflineSince(null);
    setConfig(null);
    setExpired(false);
  }, []);

  const acceptToken = useCallback((t: string) => {
    setExpired(false);
    saveToken(t);
  }, [saveToken]);

  const signIn = useCallback(async (email: string, password: string) => {
    const s = serverRef.current;
    if (!s) throw new ApiError(0, 'No server', 'badAddress');
    const step = await login(s, email, password);
    if (step.kind === 'token') acceptToken(step.token);
    return step;
  }, [acceptToken]);

  const verifyCode = useCallback(async (ticket: string, method: 'totp' | 'recovery', code: string) => {
    const s = serverRef.current;
    if (!s) throw new ApiError(0, 'No server', 'badAddress');
    acceptToken(await verifySignIn(s, ticket, method, code));
  }, [acceptToken]);

  const signOut = useCallback(async () => {
    const s = serverRef.current;
    await unregisterPush(client).catch(() => {});
    saveToken(null);
    setBoot(null);
    setOfflineSince(null);
    setExpired(false);
    if (s) clearCache(s);
  }, [client, saveToken]);

  const forget = useCallback(async (origin: string) => {
    const t = await getItem(tokenKey(origin));
    if (t) {
      const other = createClient(origin, () => t, { onUnauthorized: () => {}, onToken: () => {} });
      await unregisterPush(other).catch(() => {});
    }
    await setItem(tokenKey(origin), null);
    clearCache(origin);
    saveAccounts(accountsRef.current.filter((a) => a.server !== origin));
    if (serverRef.current === origin) {
      startAdding();
      await setItem('server', null);
    }
  }, [saveAccounts, startAdding]);

  const features = featuresOf(boot, config);
  // The restaurant's look (Settings → Branding): its data first, so a change there shows on the next refresh.
  const saved = server ? accounts.find((a) => a.server === server)?.brand : undefined;
  const brand = brandFrom({ boot, config, saved, signedIn: !!token });
  const dark = isDark(brand.mode, scheme);
  const colors = useMemo(() => palette(dark, brand), [dark, brand.brand, brand.nav, brand.bg]); // eslint-disable-line react-hooks/exhaustive-deps
  const logoPath = brand.logo;
  // Keep the latest with the account, for the next start. Signed in, only the restaurant's data counts (it has
  // the person's own appearance); signed out, the sign-in page's Branding.
  useEffect(() => {
    if (!server || (!boot && (token || !config?.brand))) return;
    const fresh = brandFrom({ boot, config });
    patchAccount(server, { brand: fresh, color: fresh.brand || undefined, logo: fresh.logo || undefined });
  }, [server, boot, config, token, patchAccount]);
  const value = useMemo<Session>(() => {
    const me = boot?.me;
    const st = boot?.settings;
    const rank = me ? RANK[me.role] || 1 : 0;
    return {
      ready, accounts, server, config, token, boot, bootError, offlineSince, expired, client, version, colors,
      logoUrl: server && logoPath ? `${server}${logoPath}` : null,
      jobs: Object.fromEntries((boot?.jobCodes || []).map((j) => [j.id, j])),
      people: Object.fromEntries((boot?.employees || []).map((p) => [p.id, p])),
      canApprove: !!me && (rank >= 3 || (me.role === 'supervisor' && st?.supervisorsCanApprove !== false)),
      isMgr: rank >= 3,
      isEvents: rank >= 3 || !!me?.eventsAccess || (me?.role as string) === 'events',
      isLead: rank >= 2,
      features,
      has: (f: Feature) => featureOn(features, f),
      cachePrefix: server || '',
      openRestaurant, startAdding, forget, signIn, verifyCode, acceptToken, signOut, refresh, bump,
    };
  }, [ready, accounts, server, config, token, boot, bootError, offlineSince, expired, client, version, colors, logoPath, features, openRestaurant, startAdding, forget, signIn, verifyCode, acceptToken, signOut, refresh, bump]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** Shorthand for screens that only render when signed in and loaded. */
export function useApp() {
  const s = useSession();
  return { ...s, boot: s.boot as Boot, me: s.boot!.me, settings: s.boot!.settings, today: s.boot!.today };
}
