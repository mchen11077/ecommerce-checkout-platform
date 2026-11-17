import { useMemo, useState } from 'react';
import {
  CouponApiError,
  CouponClient,
  CouponNetworkError,
  CouponProtocolError,
} from '@xumeiqi/coupon-client';

import { AttemptList, type Attempt } from './components/AttemptList';
import { CouponCatalog } from './components/CouponCatalog';
import { ResultBanner } from './components/ResultBanner';
import { copyFor, type Tone } from './messages';

interface Outcome {
  code: string;
  message: string;
  tone: Tone;
  status?: number;
}

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? window.location.origin;

export default function App() {
  const client = useMemo(() => new CouponClient({ baseUrl: API_BASE }), []);

  const [couponId, setCouponId] = useState('1');
  const [userId, setUserId] = useState('1');
  const [orderAmount, setOrderAmount] = useState('120.00');
  const [orderId, setOrderId] = useState('order-1');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);

  async function run(action: string, call: () => Promise<{ result: string }>) {
    setBusy(true);
    let next: Outcome;
    try {
      const { result } = await call();
      next = { code: result, ...copyFor(result) };
    } catch (error) {
      if (error instanceof CouponApiError) {
        next = { code: error.code, status: error.status, ...copyFor(error.code) };
      } else if (error instanceof CouponNetworkError) {
        next = { code: 'NETWORK', message: error.message, tone: 'bad' };
      } else if (error instanceof CouponProtocolError) {
        next = { code: 'PROTOCOL', message: error.message, tone: 'bad' };
      } else {
        throw error;
      }
    } finally {
      setBusy(false);
    }
    setOutcome(next);
    const at = new Date().toLocaleTimeString();
    setAttempts((previous) => [
      { id: previous.length + 1, action, code: next.code, at },
      ...previous,
    ]);
  }

  const coupon = Number(couponId);
  const user = Number(userId);

  return (
    <main className="page">
      <header className="page__header">
        <h1>Coupons</h1>
        <p className="page__hint">
          Select a coupon or enter its ID, then claim it, check eligibility, or redeem it.
        </p>
      </header>

      <div className="workspace">
        <CouponCatalog baseUrl={API_BASE} selectedId={couponId} disabled={busy} onSelect={(id) => {
          setCouponId(id);
          setOutcome(null);
        }} />
        <section className="card">
          <h2 className="card__title">Coupon actions</h2>

          <div className="field-grid">
            <label>
              Coupon ID
              <input value={couponId} onChange={(event) => setCouponId(event.target.value)} inputMode="numeric" />
            </label>
            <label>
              User ID
              <input value={userId} onChange={(event) => setUserId(event.target.value)} inputMode="numeric" />
            </label>
            <label>
              Order amount
              <input value={orderAmount} onChange={(event) => setOrderAmount(event.target.value)} inputMode="decimal" />
            </label>
            <label>
              Order ID
              <input value={orderId} onChange={(event) => setOrderId(event.target.value)} />
            </label>
          </div>

          <div className="actions">
            <button className="button-primary" type="button" disabled={busy}
              onClick={() => run('claim', () => client.claim(coupon, user))}>
              Claim
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run('eligibility', () => client.checkEligibility(coupon, { userId: user, orderAmount }))}
            >
              Check eligibility
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run('redeem', () => client.redeem(coupon, user, { orderAmount, orderId }))}
            >
              Redeem
            </button>
          </div>

          {outcome && (
            <ResultBanner code={outcome.code} message={outcome.message} tone={outcome.tone} status={outcome.status} />
          )}
        </section>
      </div>

      <section className="card">
        <h2 className="card__title">Attempts</h2>
        <AttemptList attempts={attempts} />
      </section>
    </main>
  );
}
