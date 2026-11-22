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
 * With `cache` (a name, like 'myShifts'), the last result is kept on the phone: it shows right away while the
 * fresh one loads, and stays on screen with `updatedAt` (when it was saved) when there's no connection.
 */
export function useRpc<T>(method: string, args: object = {}, deps: unknown[] = [], enabled = true, opts: { cache?: string } = {}) {
  const { client, version, token, cachePrefix } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const seq = useRef(0);
  const fresh = useRef(false);
  const argsKey = JSON.stringify(args);
  const cacheKey = opts.cache && cachePrefix ? `${cachePrefix}|${opts.cache}` : null;

  // The copy from last time, first.
  useEffect(() => {
    if (!cacheKey || !enabled) return;
    let live = true;
    readCache<{ args: string; data: T }>(cacheKey).then((c) => {
      if (!live || !c || fresh.current) return;
      setData((cur) => cur ?? c.data.data);
      setUpdatedAt(c.at);
    });
    return () => { live = false; };
  }, [cacheKey, enabled]);

  const load = useCallback(async () => {
    if (!token || !enabled) return;
    const n = ++seq.current;
    try {
      const r = await client.call<T>(method, JSON.parse(argsKey));
      if (n !== seq.current) return;
      fresh.current = true;
      setData(r);
      setError(null);
      setUpdatedAt(null);
      if (cacheKey) writeCache(cacheKey, { args: argsKey, data: r });
    } catch (e) {
      if (n !== seq.current) return;
      setError(e);
      if (cacheKey && isOffline(e)) {
        const c = await readCache<{ args: string; data: T }>(cacheKey);
        if (c && n === seq.current) { setData((cur) => cur ?? c.data.data); setUpdatedAt(c.at); }
      }
    }
  }, [client, method, argsKey, token, enabled, cacheKey]);
  useEffect(() => { load(); }, [load, version, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: load, loading: data == null && error == null, updatedAt, offline: !!updatedAt && isOffline(error) };
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
