'use client';

import { useTranslations } from 'next-intl';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';

export interface SessionInfo {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly orgRoles: string[];
  readonly csrfToken: string;
  readonly permissions: string[];
}

const SessionContext = createContext<SessionInfo | null>(null);

export function SessionProvider({ value, children }: { value: SessionInfo | null; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
export const useCan = () => {
  const s = useSession();
  return (permission: string) => s?.permissions.includes(permission) ?? false;
};

/** An API error: a stable code plus params (doc 20 §9). */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly params: Record<string, string | number | boolean>,
  ) {
    super(code);
  }
}

export interface ApiOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  /** Extra request headers, e.g. the setup token of the first-run page. */
  readonly headers?: Record<string, string>;
}

/** Calls the API through the web origin's proxy. State-changing calls carry the CSRF token. */
export async function callApi<T>(
  path: string,
  opts: ApiOptions & { csrfToken?: string | null } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && opts.csrfToken) headers['x-csrf-token'] = opts.csrfToken;
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const err = (data ?? {}) as { code?: string; params?: Record<string, string | number | boolean> };
    throw new ApiFailure(res.status, err.code ?? `http.${res.status}`, err.params ?? {});
  }
  return data as T;
}

export function useApi() {
  const session = useSession();
  return useCallback(
    <T,>(path: string, opts: ApiOptions = {}) =>
      callApi<T>(path, { ...opts, csrfToken: session?.csrfToken ?? null }),
    [session],
  );
}

/** Turns any error into a translated sentence; unknown codes fall back to a generic message. */
export function useErrorText() {
  const t = useTranslations('errors');
  return useMemo(
    () => (e: unknown) => {
      if (e instanceof ApiFailure) {
        const key = e.code.replace(/\./g, '_');
        if (t.has(key)) return t(key, e.params as Record<string, string>);
        return t('generic', { code: e.code });
      }
      return t('network');
    },
    [t],
  );
}
