// Loading data and running actions with feedback.
import { useCallback, useEffect, useRef, useState } from 'react';

import { useToast } from '@/components/ui';
import { useI18n } from '@/i18n';
import { ApiError } from './api';
import { readCache, writeCache } from './cache';
import { useSession } from './session';

/** The message to show for a failed call: the server's words, or ours for network problems. */
export function useErrorText() {
  const { t } = useI18n();
  return (e: unknown) => (e instanceof ApiError && e.code === 'network' ? t('common.networkError') : e instanceof Error && e.message ? e.message : t('errors.generic'));
}

export const isOffline = (e: unknown) => e instanceof ApiError && e.code === 'network';

/**
 * Call an RPC method and keep the result; reloads when data changes anywhere (session.version) or deps change.
 * Results belong to their arguments: after the arguments change (another week), data is null until the new
 * answer comes, so a screen never shows last week's shifts under this week's heading.
 * With `cache` (a name, like 'myShifts'), the last result is kept on the phone: it shows right away while the
 * fresh one loads, and stays on screen with `updatedAt` (when it was saved) when there's no connection.
 */
export function useRpc<T>(method: string, args: object = {}, deps: unknown[] = [], enabled = true, opts: { cache?: string } = {}) {
  const { client, version, token, cachePrefix } = useSession();
  const argsKey = JSON.stringify(args);
  const key = `${method}|${argsKey}`;
  const [got, setGot] = useState<{ key: string; data: T; at: string | null } | null>(null);
  const [err, setErr] = useState<{ key: string; error: unknown } | null>(null);
  const seq = useRef(0);
  const cacheKey = opts.cache && cachePrefix ? `${cachePrefix}|${opts.cache}` : null;

  // The copy from last time, first (never over a fresh answer).
  useEffect(() => {
    if (!cacheKey || !enabled) return;
    let live = true;
    readCache<{ args: string; data: T }>(cacheKey).then((c) => {
      if (live && c) setGot((cur) => (cur && cur.key === key ? cur : { key, data: c.data.data, at: c.at }));
    });
    return () => { live = false; };
  }, [cacheKey, enabled, key]);

  const load = useCallback(async () => {
    if (!token || !enabled) return;
    const n = ++seq.current;
    const k = `${method}|${argsKey}`;
    try {
      const r = await client.call<T>(method, JSON.parse(argsKey));
      if (n !== seq.current) return;
      setGot({ key: k, data: r, at: null });
      setErr(null);
      if (cacheKey) writeCache(cacheKey, { args: argsKey, data: r });
    } catch (e) {
      if (n !== seq.current) return;
      setErr({ key: k, error: e });
      if (cacheKey && isOffline(e)) {
        const c = await readCache<{ args: string; data: T }>(cacheKey);
        if (c && n === seq.current) setGot((cur) => (cur && cur.key === k ? cur : { key: k, data: c.data.data, at: c.at }));
      }
    }
  }, [client, method, argsKey, token, enabled, cacheKey]);
  useEffect(() => { load(); }, [load, version, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  const mine = got && got.key === key ? got : null;
  const data = mine ? mine.data : null;
  const error = err && err.key === key ? err.error : null;
  const updatedAt = mine?.at ?? null;
  /** done: an answer (or an error) came back; data can then be null when the server says there's nothing. */
  const done = (!!mine && !mine.at) || error != null;
  return { data, error, reload: load, loading: !done && data == null, done, updatedAt, offline: !!updatedAt && isOffline(error) };
}

/** Run something that changes data: shows a toast, then refreshes every screen. */
export function useAction() {
  const { bump } = useSession();
  const toast = useToast();
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <R,>(fn: () => Promise<R>, ok?: string | ((r: R) => string)): Promise<R | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast(typeof ok === 'function' ? ok(r) : ok);
      bump();
      return r;
    } catch (e) {
      toast(errorText(e), 'bad');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [bump, toast, errorText]);
  return [run, busy] as const;
}
