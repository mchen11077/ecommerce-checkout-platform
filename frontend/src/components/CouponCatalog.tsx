import { useEffect, useState } from 'react';

interface ListedCoupon {
  id: number;
  name: string;
  minOrderAmount: number;
  validFrom: string;
  validUntil: string;
}

type CatalogState = { status: 'loading' | 'error' } | { status: 'ready'; coupons: ListedCoupon[] };

interface Props {
  baseUrl: string;
  selectedId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function CouponCatalog({ baseUrl, selectedId, disabled, onSelect }: Props) {
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' });
  const [request, setRequest] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/coupons`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const coupons: ListedCoupon[] = await response.json();
        if (!Array.isArray(coupons)) throw new Error('Expected a coupon list');
        if (!controller.signal.aborted) setCatalog({ status: 'ready', coupons });
      } catch {
        if (!controller.signal.aborted) setCatalog({ status: 'error' });
      }
    }
    void load();
    return () => controller.abort();
  }, [baseUrl, request]);

  return (
    <section className="card" aria-labelledby="catalog-title">
      <div className="catalog-heading">
        <h2 className="card__title" id="catalog-title">Available coupons</h2>
        <button type="button" disabled={catalog.status === 'loading'} onClick={() => {
          setCatalog({ status: 'loading' });
          setRequest((previous) => previous + 1);
        }}>Refresh</button>
      </div>
      {catalog.status === 'loading' && <p className="page__hint" aria-live="polite">Loading coupons…</p>}
      {catalog.status === 'error' && <p className="page__hint" aria-live="polite">Could not load coupons. Try refreshing.</p>}
      {catalog.status === 'ready' && (catalog.coupons.length === 0
        ? <p className="page__hint" aria-live="polite">No active coupons right now.</p>
        : <ul className="catalog">
          {catalog.coupons.map((coupon) => {
            const id = String(coupon.id);
            return (
              <li key={id}>
                <button className="catalog-option" type="button" aria-pressed={selectedId === id}
                  disabled={disabled} onClick={() => onSelect(id)}>
                  <strong>{coupon.name}</strong>
                  <span>Coupon #{id} · Minimum order {coupon.minOrderAmount.toFixed(2)}</span>
                  <span>{date.format(new Date(coupon.validFrom))} – {date.format(new Date(coupon.validUntil))}</span>
                </button>
              </li>
            );
          })}
        </ul>)}
    </section>
  );
}
