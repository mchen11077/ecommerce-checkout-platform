import { describe, expect, it } from 'vitest';

import { CouponApiError, CouponClient, CouponNetworkError, CouponProtocolError } from '../src/index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  url: string;
  init?: RequestInit;
}

function recordingFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

describe('claim', () => {
  it('posts to the claim endpoint with the default redis mode', async () => {
    const { fn, calls } = recordingFetch(() => jsonResponse(200, { result: 'OK' }));
    const client = new CouponClient({ baseUrl: 'http://localhost:8080', fetch: fn });

    const body = await client.claim(7, 42);

    expect(body).toEqual({ result: 'OK' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://localhost:8080/api/coupons/7/claim?userId=42&mode=redis');
    expect(calls[0]!.init?.method).toBe('POST');
  });

  it('passes an explicit mode through', async () => {
    const { fn, calls } = recordingFetch(() => jsonResponse(200, { result: 'OK' }));
    const client = new CouponClient({ baseUrl: 'http://localhost:8080', fetch: fn });

    await client.claim(7, 42, { mode: 'naive' });

    expect(calls[0]!.url).toContain('mode=naive');
  });

  it.each([
    ['SOLD_OUT', 409],
    ['ALREADY_CLAIMED', 409],
    ['NOT_ISSUED', 409],
    ['RATE_LIMITED', 429],
    ['LOCK_TIMEOUT', 503],
  ])('surfaces %s as a typed rejection', async (code, status) => {
    const { fn } = recordingFetch(() => jsonResponse(status, { result: code }));
    const client = new CouponClient({ baseUrl: 'http://localhost:8080', fetch: fn });

    const error = await client.claim(7, 42).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CouponApiError);
    const apiError = error as CouponApiError;
    expect(apiError.code).toBe(code);
    expect(apiError.status).toBe(status);
  });
});

describe('eligibility', () => {
  it('keeps the decimal as a string in the query', async () => {
    const { fn, calls } = recordingFetch(() => jsonResponse(200, { result: 'ELIGIBLE' }));
    const client = new CouponClient({ baseUrl: 'http://localhost:8080', fetch: fn });

    const body = await client.checkEligibility(7, { userId: 42, orderAmount: '49.99' });

    expect(body).toEqual({ result: 'ELIGIBLE' });
    expect(calls[0]!.url).toContain('orderAmount=49.99');
    expect(calls[0]!.init?.method).toBe('GET');
  });

  it('reports a below-minimum order as BELOW_MIN_ORDER', async () => {
    const { fn } = recordingFetch(() => jsonResponse(409, { result: 'BELOW_MIN_ORDER' }));
    const client = new CouponClient({ baseUrl: 'http://localhost:8080', fetch: fn });

    await expect(client.checkEligibility(7, { userId: 42, orderAmount: '49.99' })).rejects.toMatchObject({
      name: 'CouponApiError',
      code: 'BELOW_MIN_ORDER',
      status: 409,
    });
  });
});

describe('redeem', () => {
  it('sends the order id and amount', async () => {
    const { fn, calls } = recordingFetch(() => jsonResponse(200, { result: 'REDEEMED' }));
    const client = new CouponClient({ baseUrl: 'http://localhost:8080', fetch: fn });

    await client.redeem(7, 42, { orderAmount: 120, orderId: 'order-1' });

    expect(calls[0]!.url).toBe(
      'http://localhost:8080/api/coupons/7/redeem?userId=42&orderAmount=120&orderId=order-1',
    );
  });

  it('refuses to call the service without an order id', async () => {
    const { fn, calls } = recordingFetch(() => jsonResponse(200, { result: 'REDEEMED' }));
    const client = new CouponClient({ baseUrl: 'http://localhost:8080', fetch: fn });

    await expect(client.redeem(7, 42, { orderAmount: 120, orderId: '' })).rejects.toBeInstanceOf(
      CouponProtocolError,
    );
    expect(calls).toHaveLength(0);
  });

  it('reports ALREADY_REDEEMED', async () => {
    const { fn } = recordingFetch(() => jsonResponse(409, { result: 'ALREADY_REDEEMED' }));
    const client = new CouponClient({ baseUrl: 'http://localhost:8080', fetch: fn });

    await expect(client.redeem(7, 42, { orderAmount: 120, orderId: 'o' })).rejects.toMatchObject({
      code: 'ALREADY_REDEEMED',
    });
  });
});

describe('transport failures', () => {
  it('wraps a connection failure as CouponNetworkError', async () => {
    const fn = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const client = new CouponClient({ baseUrl: 'http://localhost:8080', fetch: fn });

    await expect(client.claim(7, 42)).rejects.toBeInstanceOf(CouponNetworkError);
  });

  it('aborts after the configured timeout', async () => {
    const fn = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof globalThis.fetch;
    const client = new CouponClient({ baseUrl: 'http://localhost:8080', fetch: fn, timeoutMs: 10 });

    const error = await client.claim(7, 42).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CouponNetworkError);
    expect((error as Error).message).toContain('timed out after 10ms');
  });

  it('rejects a 2xx response without a result code', async () => {
    const { fn } = recordingFetch(() => jsonResponse(200, { unexpected: true }));
    const client = new CouponClient({ baseUrl: 'http://localhost:8080', fetch: fn });

    await expect(client.claim(7, 42)).rejects.toBeInstanceOf(CouponProtocolError);
  });

  it('normalises a trailing slash in baseUrl', async () => {
    const { fn, calls } = recordingFetch(() => jsonResponse(200, { result: 'OK' }));
    const client = new CouponClient({ baseUrl: 'http://localhost:8080/', fetch: fn });

    await client.claim(7, 42);

    expect(calls[0]!.url).toBe('http://localhost:8080/api/coupons/7/claim?userId=42&mode=redis');
  });
});
