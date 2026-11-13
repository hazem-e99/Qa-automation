import { cookies } from 'next/headers';

/** API base URL: a server-side setting, never sent to the browser. */
export const apiBaseUrl = () => (process.env.QOS_API_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');

export interface Me {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly orgRoles: string[];
  readonly csrfToken: string;
}

export type Session =
  | { readonly state: 'signed_in'; readonly me: Me; readonly permissions: string[] }
  | { readonly state: 'signed_out' }
  | { readonly state: 'unreachable' };

/** GET against the API with the caller's session cookie, from a server component. */
export async function serverGet<T>(path: string): Promise<{ status: number; data: T | null }> {
  const session = (await cookies()).get('qos_session')?.value;
  try {
    const res = await fetch(`${apiBaseUrl()}/api/v1${path}`, {
      headers: session ? { cookie: `qos_session=${session}` } : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    return { status: res.status, data: res.ok ? ((await res.json()) as T) : null };
  } catch {
    return { status: 0, data: null };
  }
}

/** Who is signed in. "unreachable" lets pages render a useful state while the API is down. */
export async function getSession(): Promise<Session> {
  const me = await serverGet<Me>('/me');
  if (me.status === 0 || me.status >= 500) return { state: 'unreachable' };
  if (!me.data) return { state: 'signed_out' };
  const perms = await serverGet<{ org: string[] }>('/me/permissions');
  return { state: 'signed_in', me: me.data, permissions: perms.data?.org ?? [] };
}
