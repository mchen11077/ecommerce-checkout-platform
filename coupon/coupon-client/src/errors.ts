/** A rejection: the service answered with a status and a `result` code. */
export class CouponApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly body: unknown;

  constructor(code: string, status: number, body: unknown) {
    super(`coupon service rejected the request: ${code} (HTTP ${status})`);
    this.name = 'CouponApiError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

/** No response: DNS, reset connection, abort or timeout. */
export class CouponNetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CouponNetworkError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** A 2xx whose body was not `{ result: string }`, or an argument the client will not send. */
export class CouponProtocolError extends Error {
  readonly body: unknown;

  constructor(message: string, body: unknown) {
    super(message);
    this.name = 'CouponProtocolError';
    this.body = body;
  }
}
