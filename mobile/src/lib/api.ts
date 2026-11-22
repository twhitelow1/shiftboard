// Talking to a restaurant's ShiftBoard server. Each restaurant has its own deployment
// (its own address and database); the app remembers which one this phone uses.
// Every call is POST <server>/api/rpc/<method> with a JSON body; the session is sent as
// Authorization: Bearer <token> (see server/app.js).
import { LINK_SCHEMES } from '@/brand';
import type { ServerConfig } from './types';

/** status 0 = no answer (offline, wrong address); code is for messages the app words itself. */
export class ApiError extends Error {
  status: number;
  code: 'network' | 'notShiftBoard' | 'badAddress' | 'server';
  constructor(status: number, message: string, code: ApiError['code'] = 'server') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)$/i;

const INVITE = new RegExp(`^(${LINK_SCHEMES.join('|')}):\\/*`, 'i');

/**
 * Turn what someone typed, pasted or opened (an address, a link to the web app, or an invite
 * link like shiftboard://join?server=…) into the server's origin, e.g. https://rabbits.vercel.app.
 * Plain http is only allowed for local test servers. Returns null if it can't be an address.
 */
export function parseServerInput(input: string): string | null {
  let s = String(input || '').trim();
  if (!s) return null;
  if (INVITE.test(s)) {
    try {
      const inner = new URL(s.replace(INVITE, 'https://app/')).searchParams.get('server');
      return inner ? parseServerInput(inner) : null;
    } catch {
      return null;
    }
  }
  if (/\s/.test(s)) return null;
  // No scheme: https, except plain http for a test server on this computer or network.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${LOCAL_HOST.test(s.split(/[/:?#]/)[0]) ? 'http' : 'https'}://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname.includes('.') && !LOCAL_HOST.test(u.hostname)) return null;
    if (u.protocol === 'http:' && !LOCAL_HOST.test(u.hostname)) u.protocol = 'https:';
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/** The address without https://, for showing people. */
export const displayServer = (origin: string) => origin.replace(/^https:\/\//, '');

async function request(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch {
    throw new ApiError(0, 'Network error', 'network');
  } finally {
    clearTimeout(timer);
  }
}

async function json(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Check that an address is a ShiftBoard server, and get its name, logo and color. */
export async function fetchConfig(server: string): Promise<ServerConfig> {
  const res = await request(`${server}/api/config`, { headers: { Accept: 'application/json' } }, 12000);
  const body = await json(res);
  if (!res.ok || !body || typeof body !== 'object' || !('email' in body)) throw new ApiError(res.status, 'Not a ShiftBoard server', 'notShiftBoard');
  return {
    email: !!body.email, brand: body.brand || null,
    ...(body.features && typeof body.features === 'object' ? { features: body.features } : {}),
    ...(body.paused ? { paused: true } : {}),
  };
}

/** Sign in. Returns the session token (valid 30 days). */
export async function login(server: string, email: string, password: string): Promise<string> {
  const res = await request(`${server}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: email.trim(), password, client: 'mobile' }),
  });
  const body = await json(res);
  if (!res.ok || !body?.token) throw new ApiError(res.status, body?.error || `Sign-in failed (${res.status})`);
  return body.token;
}

/** Ask for a password reset email. The link opens the web app, where the new password is set. */
export async function forgotPassword(server: string, email: string): Promise<void> {
  const res = await request(`${server}/api/auth/forgot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: email.trim() }),
  });
  const body = await json(res);
  if (!res.ok) throw new ApiError(res.status, body?.error || `Request failed (${res.status})`);
}

export interface Client {
  call<T = any>(method: string, args?: object): Promise<T>;
  post<T = any>(path: string, args?: object): Promise<T>;
}

/**
 * A client for one server and session. onUnauthorized runs when the session has ended
 * (401: expired, or signed out by a password change); onToken when the server hands back a
 * fresh token (after changing the password from the app).
 */
export function createClient(server: string, getToken: () => string | null, hooks: { onUnauthorized: () => void; onToken: (t: string) => void }): Client {
  async function post<T>(path: string, args: object = {}): Promise<T> {
    const token = getToken();
    const res = await request(`${server}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(args),
    });
    const fresh = res.headers.get('x-session-token');
    if (fresh) hooks.onToken(fresh);
    const body = await json(res);
    if (res.status === 401) {
      hooks.onUnauthorized();
      throw new ApiError(401, body?.error || 'Please sign in');
    }
    if (!res.ok) throw new ApiError(res.status, body?.error || `Request failed (${res.status})`);
    return (body?.result ?? null) as T;
  }
  return {
    post,
    call: (method, args) => post(`/api/rpc/${method}`, args),
  };
}
