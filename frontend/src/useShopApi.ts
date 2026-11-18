import { useMemo, useState } from 'react';
import { CouponApiError, CouponClient } from '@xumeiqi/coupon-client';

export interface BrowserSession {
  userId: string | null;
  csrfHeader: string;
  csrfParameter: string;
  csrfToken: string;
}

export function useShopApi(session: BrowserSession | undefined, configuredApi: string) {
  const [sessionExpired, setSessionExpired] = useState(false);
  const api = useMemo(() => {
    const baseUrl = session ? window.location.origin : configuredApi;
    let current = session;
    let refreshing: Promise<BrowserSession> | undefined;
    const send: typeof fetch = async (input, options) => {
      const invoke = () => {
        const headers = new Headers(options?.headers);
        if (current && options?.method === 'POST') headers.set(current.csrfHeader, current.csrfToken);
        return fetch(input, { ...options, headers });
      };
      const previousToken = current?.csrfToken;
      let response = await invoke();
      if (session && (response.status === 401 || response.status === 403)) {
        if (!refreshing) {
          refreshing = fetch('/api/session', { cache: 'no-store' }).then(async result => {
            if (!result.ok) throw new Error('Could not verify your session. Please retry.');
            return result.json() as Promise<BrowserSession>;
          }).finally(() => { refreshing = undefined; });
        }
        const renewed = await refreshing;
        if (renewed.userId !== session.userId || (session.userId !== null && response.status === 401)) {
          setSessionExpired(true);
          return Response.json({ result: 'SESSION_EXPIRED' }, { status: 401 });
        }
        current = renewed;
        if (previousToken !== renewed.csrfToken) response = await invoke();
      }
      return response;
    };
    async function request<T>(path: string, options?: RequestInit): Promise<T> {
      const response = await send(baseUrl + path, options);
      if (!response.ok) {
        const body = await response.json().catch(() => ({ result: 'UNKNOWN' }));
        throw new CouponApiError(body.result ?? 'UNKNOWN', response.status, body);
      }
      return response.json() as Promise<T>;
    }
    return { client: new CouponClient({ baseUrl, fetch: send }), request };
  }, [session, configuredApi]);
  return { ...api, sessionExpired };
}
