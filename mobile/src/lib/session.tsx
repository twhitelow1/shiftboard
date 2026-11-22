// The app's state: which restaurant server this phone uses, the sign-in, and the restaurant's
// data that every screen needs (app.bootstrap: settings, positions, people, me).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, useColorScheme } from 'react-native';

import { useI18n } from '@/i18n';
import { ApiError, createClient, fetchConfig, login, type Client } from './api';
import { registerForPush, unregisterPush, onPushReceived } from './push';
import { getItem, setItem } from './storage';
import { palette, type Palette } from './theme';
import type { Boot, JobCode, Person, ServerConfig } from './types';

interface Session {
  /** Saved values have been read from the phone. */
  ready: boolean;
  server: string | null;
  config: ServerConfig | null;
  token: string | null;
  boot: Boot | null;
  bootError: ApiError | null;
  /** The last session ended on its own (expired, or signed out by a password change). */
  expired: boolean;
  client: Client;
  /** Goes up whenever data changed; screens reload when it does. */
  version: number;
  colors: Palette;
  logoUrl: string | null;
  jobs: Record<string, JobCode>;
  people: Record<string, Person>;
  canApprove: boolean;
  setServer: (origin: string | null, config?: ServerConfig | null) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  bump: () => void;
}

const Ctx = createContext<Session | null>(null);
const APPROVER_ROLES = ['super_admin', 'admin', 'manager'];

export function SessionProvider({ children }: { children: ReactNode }) {
  const i18n = useI18n();
  const scheme = useColorScheme();
  const [ready, setReady] = useState(false);
  const [server, setServerState] = useState<string | null>(null);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [boot, setBoot] = useState<Boot | null>(null);
  const [bootError, setBootError] = useState<ApiError | null>(null);
  const [expired, setExpired] = useState(false);
  const [version, setVersion] = useState(0);
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;

  const saveToken = useCallback((t: string | null) => {
    tokenRef.current = t;
    setToken(t);
    setItem('token', t).catch(() => {});
  }, []);

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

  // Read what's saved on the phone.
  useEffect(() => {
    (async () => {
      const [s, t] = await Promise.all([getItem('server'), getItem('token')]);
      setServerState(s);
      tokenRef.current = t;
      setToken(t);
      setReady(true);
      if (s) fetchConfig(s).then(setConfig).catch(() => {});
    })();
  }, []);

  const refresh = useCallback(async () => {
    if (!server || !tokenRef.current) return;
    try {
      const b = await client.call<Boot>('app.bootstrap');
      setBoot(b);
      setBootError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) setBootError(e);
    }
  }, [client, server]);

  // Signed in: load the restaurant's data, then ask for notifications and register this phone.
  useEffect(() => {
    if (!ready || !token || !server) return;
    refresh();
  }, [ready, token, server, refresh]);
  const signedInUser = boot?.me.id;
  useEffect(() => {
    if (signedInUser) registerForPush(client).catch(() => {});
  }, [signedInUser, client]);

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

  const setServer = useCallback(async (origin: string | null, cfg: ServerConfig | null = null) => {
    if (tokenRef.current) {
      await unregisterPush(client).catch(() => {});
      saveToken(null);
    }
    setBoot(null);
    setExpired(false);
    setServerState(origin);
    setConfig(cfg);
    await setItem('server', origin);
    if (origin && !cfg) fetchConfig(origin).then(setConfig).catch(() => {});
  }, [client, saveToken]);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!server) throw new ApiError(0, 'No server', 'badAddress');
    const t = await login(server, email, password);
    setExpired(false);
    saveToken(t);
  }, [server, saveToken]);

  const signOut = useCallback(async () => {
    await unregisterPush(client).catch(() => {});
    saveToken(null);
    setBoot(null);
    setExpired(false);
  }, [client, saveToken]);

  const mode = boot?.me.appearance || boot?.settings.appearance || config?.brand?.mode || 'auto';
  const dark = mode === 'dark' || (mode !== 'light' && scheme === 'dark');
  const colors = useMemo(() => palette(dark, boot?.settings.brandColor || config?.brand?.color), [dark, boot?.settings.brandColor, config?.brand?.color]);
  const logoPath = config?.brand?.logo || (boot?.settings.logoVersion ? `/api/branding/logo?v=${boot.settings.logoVersion}` : '');
  const value = useMemo<Session>(() => {
    const me = boot?.me;
    const st = boot?.settings;
    return {
      ready, server, config, token, boot, bootError, expired, client, version, colors,
      logoUrl: server && logoPath ? `${server}${logoPath}` : null,
      jobs: Object.fromEntries((boot?.jobCodes || []).map((j) => [j.id, j])),
      people: Object.fromEntries((boot?.employees || []).map((p) => [p.id, p])),
      canApprove: !!me && (APPROVER_ROLES.includes(me.role) || (me.role === 'supervisor' && st?.supervisorsCanApprove !== false)),
      setServer, signIn, signOut, refresh, bump,
    };
  }, [ready, server, config, token, boot, bootError, expired, client, version, colors, logoPath, setServer, signIn, signOut, refresh, bump]);

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
