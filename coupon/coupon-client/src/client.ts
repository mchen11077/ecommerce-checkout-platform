import { CouponApiError, CouponNetworkError, CouponProtocolError } from './errors.js';
import type {
  ApiBody,
  ClaimOptions,
  ClaimResult,
  CouponClientOptions,
  EligibilityOptions,
  EligibilityResult,
  Money,
  RedeemOptions,
  RedeemResult,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

type QueryValue = string | number | undefined;

function toQuery(params: Record<string, QueryValue>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function asMoney(value: Money): string {
  // Send decimals as strings: 50.00 must not become 50 on the way to a BigDecimal parameter.
  return typeof value === 'number' ? value.toString() : value;
}

function readResult(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const result = (body as { result?: unknown }).result;
  return typeof result === 'string' ? result : undefined;
}

/**
 * Client for the coupon service. Success resolves to `{ result }`; a rejection throws
 * {@link CouponApiError} with the service's own code, so callers switch on `SOLD_OUT`, not on 409.
 */
export class CouponClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: CouponClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const impl = options.fetch ?? globalThis.fetch;
    if (typeof impl !== 'function') {
      throw new CouponProtocolError('no fetch implementation available', undefined);
    }
    this.fetchImpl = options.fetch ?? impl.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** POST /api/coupons/{id}/claim */
  async claim(couponId: number, userId: number, options: ClaimOptions = {}): Promise<ApiBody<'OK'>> {
    const body = await this.request<ClaimResult>('POST', `/api/coupons/${couponId}/claim`, {
      userId,
      mode: options.mode ?? 'redis',
    }, options.signal);
    return body as ApiBody<'OK'>;
  }

  /** GET /api/coupons/{id}/eligibility */
  async checkEligibility(
    couponId: number,
    options: EligibilityOptions,
  ): Promise<ApiBody<'ELIGIBLE'>> {
    const body = await this.request<EligibilityResult>('GET', `/api/coupons/${couponId}/eligibility`, {
      userId: options.userId,
      orderAmount: asMoney(options.orderAmount),
    }, options.signal);
    return body as ApiBody<'ELIGIBLE'>;
  }

  /** POST /api/coupons/{id}/redeem */
  async redeem(couponId: number, userId: number, options: RedeemOptions): Promise<ApiBody<'REDEEMED'>> {
    if (!options.orderId) {
      throw new CouponProtocolError('orderId is required', undefined);
    }
    const body = await this.request<RedeemResult>('POST', `/api/coupons/${couponId}/redeem`, {
      userId,
      orderAmount: asMoney(options.orderAmount),
      orderId: options.orderId,
    }, options.signal);
    return body as ApiBody<'REDEEMED'>;
  }

  private async request<T extends string>(
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, QueryValue>,
    signal?: AbortSignal,
  ): Promise<ApiBody<T>> {
    const url = `${this.baseUrl}${path}${toQuery(query)}`;
    const controller = new AbortController();
    const timedOut = { value: false };
    const timer = setTimeout(() => {
      timedOut.value = true;
      controller.abort();
    }, this.timeoutMs);
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method, signal: controller.signal });
    } catch (cause) {
      const message = timedOut.value
        ? `coupon request timed out after ${this.timeoutMs}ms`
        : `coupon request failed before a response: ${String(cause)}`;
      throw new CouponNetworkError(message, cause);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }

    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    const code = readResult(body);
    if (!response.ok) {
      throw new CouponApiError(code ?? 'UNKNOWN', response.status, body);
    }
    if (!code) {
      throw new CouponProtocolError('response body did not contain a result code', body);
    }
    return { result: code as T };
  }
}
