// Loading data and running actions with feedback.
import { useCallback, useEffect, useRef, useState } from 'react';

import { useToast } from '@/components/ui';
import { useI18n } from '@/i18n';
import { ApiError } from './api';
import { useSession } from './session';

/** The message to show for a failed call: the server's words, or ours for network problems. */
export function useErrorText() {
  const { t } = useI18n();
  return (e: unknown) => (e instanceof ApiError && e.code === 'network' ? t('common.networkError') : e instanceof Error && e.message ? e.message : t('errors.generic'));
}

/** Call an RPC method and keep the result; reloads when data changes anywhere (session.version) or deps change. */
export function useRpc<T>(method: string, args: object = {}, deps: unknown[] = [], enabled = true) {
  const { client, version, token } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0);
  const argsKey = JSON.stringify(args);
  const load = useCallback(async () => {
    if (!token || !enabled) return;
    const n = ++seq.current;
    try {
      const r = await client.call<T>(method, JSON.parse(argsKey));
      if (n === seq.current) { setData(r); setError(null); }
    } catch (e) {
      if (n === seq.current) setError(e);
    }
  }, [client, method, argsKey, token, enabled]);
  useEffect(() => { load(); }, [load, version, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: load, loading: data == null && error == null };
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
