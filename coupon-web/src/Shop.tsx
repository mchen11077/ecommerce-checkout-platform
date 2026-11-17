import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CouponApiError, CouponClient } from '@xumeiqi/coupon-client';
import { isCartQuantity, MAX_QUANTITY, type CartLine } from './cart';
import { ShoppingCart } from './components/ShoppingCart';
import { formatMoney } from './formatMoney';
import { copyFor } from './messages';
import { clearPendingCheckout, readPendingCheckout, savePendingCheckout } from './pendingCheckout';
import { useResourceList } from './useResourceList';
import utensilPhoto from './assets/paw-utensils.webp';
import skilletPhoto from './assets/paw-skillet.webp';
import stockpotPhoto from './assets/paw-stockpot.webp';
import storagePhoto from './assets/paw-storage.webp';

const productImages: Record<string, string> = {
  'silicone-utensils': utensilPhoto,
  'nonstick-skillet': skilletPhoto,
  'stainless-stockpot': stockpotPhoto,
  'glass-storage': storagePhoto,
};

interface Coupon {
  id: number;
  name: string;
  minOrderAmount: number;
  discountAmount: number;
  validUntil: string;
  giftName?: string | null;
  remainingStock?: number | null;
  maxUsesPerUser?: number;
}

interface WalletCoupon {
  coupon: Coupon;
  status: 'AVAILABLE' | 'REDEEMED' | 'EXPIRED' | 'UPCOMING';
  remainingUses?: number;
}

interface Quote {
  couponId: number;
  cartKey: string;
  pricing: Pricing;
}

interface Pricing {
  result: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  shortfallCents: number;
  giftName?: string;
}

interface Product { id: string; name: string; cents: number; category: string; description: string }
interface Receipt { orderId: string; pricing: Pricing }
interface OrderSummary extends Receipt {
  createdAt: string;
  items: { name: string; quantity: number }[];
  paymentStatus: 'DEMO' | 'PAID' | 'REFUNDED';
  shippingStatus: 'UNSHIPPED' | 'SHIPPED';
}

export interface BrowserSession {
  userId: string | null;
  csrfHeader: string;
  csrfParameter: string;
  csrfToken: string;
}

const configuredApi = (import.meta.env.VITE_API_BASE ?? window.location.origin).replace(/\/+$/, '');
const loginPath = '/oauth2/authorization/coupon';
const initialOfferCount = 3;
const cartStorageKey = 'kitchenware-cart-v1';

function readCart(): CartLine[] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(cartStorageKey) ?? '[]');
    if (!Array.isArray(stored)) return [];
    const seen = new Set<string>();
    return stored.filter((line): line is CartLine => {
      if (!line || typeof line.productId !== 'string' || seen.has(line.productId) ||
        !isCartQuantity(line.quantity) ||
        typeof line.checked !== 'boolean') return false;
      seen.add(line.productId);
      return true;
    });
  } catch {
    return [];
  }
}

function minimumShortfall(coupon: Coupon, subtotal: number) {
  return Math.max(0, Math.round(coupon.minOrderAmount * 100) - subtotal);
}

function selectedCartKey(lines: CartLine[]) {
  return lines.filter(line => line.checked).map(line => `${line.productId}:${line.quantity}`).sort().join(',');
}

function errorMessage(error: unknown) {
  return error instanceof CouponApiError ? copyFor(error.code).message : 'Could not reach the coupon service. Try again.';
}

export default function Shop({ session }: { session?: BrowserSession } = {}) {
  const userId = session ? (session.userId === null ? null : Number(session.userId)) : 101;
  const walletPath = `/api/users/${userId}/coupons`;
  const { client, request } = useMemo(() => {
    const baseUrl = session ? window.location.origin : configuredApi;
    const send: typeof fetch = (input, options) => {
      const headers = new Headers(options?.headers);
      if (session && options?.method === 'POST') headers.set(session.csrfHeader, session.csrfToken);
      return fetch(input, { ...options, headers });
    };
    async function request<T>(path: string, options?: RequestInit): Promise<T> {
      const response = await send(baseUrl + path, options);
      const body = await response.json();
      if (!response.ok) throw new CouponApiError(body.result ?? 'UNKNOWN', response.status, body);
      return body;
    }
    return { client: new CouponClient({ baseUrl, fetch: send }), request };
  }, [session]);
  const { items: products, status: productsLoad, reload: reloadProducts } =
    useResourceList<Product>(request, '/api/checkout/products');
  const { items: catalog, status: offersLoad, reload: reloadOffers } =
    useResourceList<Coupon>(request, '/api/coupons');
  const { items: wallet, status: walletLoad, setItems: setWallet, revision: walletRevision, reload: reloadWallet } =
    useResourceList<WalletCoupon>(request, userId === null ? null : walletPath, 'no-store');
  const [showAllOffers, setShowAllOffers] = useState(false);
  const [cart, setCart] = useState(readCart);
  const [category, setCategory] = useState('');
  const [detailProduct, setDetailProduct] = useState<Product>();
  const productDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (detailProduct && !productDialog.current?.open) productDialog.current?.showModal();
  }, [detailProduct]);
  const [cartNotice, setCartNotice] = useState('');
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [stock, setStock] = useState<Record<string, number>>({});
  const [stockRevision, setStockRevision] = useState(0);
  const [orderAction, setOrderAction] = useState<string>();
  const [orderActionError, setOrderActionError] = useState('');
  const [orderPage, setOrderPage] = useState(0);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState(false);
  const [orderRevision, setOrderRevision] = useState(0);
  const [removeId, setRemoveId] = useState<string>();
  const [couponId, setCouponId] = useState(0);
  const [quote, setQuote] = useState<Quote>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [receipt, setReceipt] = useState<Receipt>();
  const [checkoutError, setCheckoutError] = useState('');
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [quoteRevision, setQuoteRevision] = useState(0);
  const [showCouponReminder, setShowCouponReminder] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const [pendingCheckout, setPendingCheckout] = useState(() => readPendingCheckout(userId));
  const submittingOrder = useRef(false);
  const cartLocked = busy || Boolean(pendingCheckout);
  const couponPicker = useRef<HTMLDetailsElement>(null);
  const couponTrigger = useRef<HTMLElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    request<{ productId: string; available: number }[]>('/api/checkout/stock',
      { signal: controller.signal, cache: 'no-store' }).then(entries => {
      if (!controller.signal.aborted && Array.isArray(entries)) {
        setStock(Object.fromEntries(entries.map(entry => [entry.productId, entry.available])));
      }
    }).catch(() => {
      if (!controller.signal.aborted) setStock({});
    });
    return () => controller.abort();
  }, [request, stockRevision]);
  useEffect(() => {
    function dismissCouponOptions(event: PointerEvent) {
      const picker = couponPicker.current;
      if (picker?.open && event.target instanceof Node && !picker.contains(event.target)) picker.open = false;
    }
    document.addEventListener('pointerdown', dismissCouponOptions);
    return () => document.removeEventListener('pointerdown', dismissCouponOptions);
  }, []);

  const available = wallet.filter(({ status }) => status === 'AVAILABLE')
    .sort((a, b) => Date.parse(a.coupon.validUntil) - Date.parse(b.coupon.validUntil) || b.coupon.id - a.coupon.id);
  const upcoming = wallet.filter(({ status }) => status === 'UPCOMING');
  const history = wallet.filter(({ status }) => status === 'REDEEMED' || status === 'EXPIRED');
  const selected = available.find(({ coupon }) => coupon.id === couponId)?.coupon;
  const selectedId = selected?.id;
  const lines = products.flatMap(product => {
    const line = cart.find(item => item.productId === product.id);
    return line ? [{ ...line, product }] : [];
  });
  const checkedLines = lines.filter(line => line.checked);
  const cartKey = selectedCartKey(lines);
  const cartSubtotal = checkedLines.reduce((sum, line) => sum + line.product.cents * line.quantity, 0);
  const currentQuote = quote?.couponId === selectedId && quote?.cartKey === cartKey ? quote?.pricing : undefined;
  const checkoutBlocked = busy || Boolean(removeId);
  const canStartCheckout = !checkoutBlocked && productsLoad === 'ready' && Boolean(cartKey)
    && (!selected || currentQuote?.result === 'ELIGIBLE');
  const subtotal = currentQuote?.subtotalCents ?? cartSubtotal;
  const discount = currentQuote?.discountCents ?? 0;
  const shortfall = currentQuote?.shortfallCents ?? 0;
  const hasUsableCoupon = Boolean(cartKey && available.some(({ coupon }) =>
    minimumShortfall(coupon, cartSubtotal) === 0));
  const walletStatus = new Map(wallet.map(({ coupon, status }) => [coupon.id, status]));
  const candidates = catalog.filter(coupon => {
    const status = walletStatus.get(coupon.id);
    return (status ? status === 'AVAILABLE' : coupon.remainingStock !== 0)
      && (coupon.discountAmount > 0 || coupon.giftName);
  });
  const recommended = cartKey ? candidates.filter(coupon => minimumShortfall(coupon, cartSubtotal) === 0)
    .sort((a, b) => Math.min(b.discountAmount, cartSubtotal / 100) - Math.min(a.discountAmount, cartSubtotal / 100)
      || Number(Boolean(b.giftName)) - Number(Boolean(a.giftName)))[0]
    : undefined;
  const orderedOffers = recommended ? [recommended, ...catalog.filter(coupon => coupon.id !== recommended.id)] : catalog;
  const visibleOffers = showAllOffers ? orderedOffers : orderedOffers.slice(0, initialOfferCount);

  async function signOut(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (signingOut) return;
    const form = event.currentTarget;
    setSigningOut(true);
    setSignOutError('');
    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      if (!response.ok) throw new Error('Session unavailable');
      const current: BrowserSession = await response.json();
      if (current.userId === null) {
        window.location.replace('/');
        return;
      }
      const token = form.querySelector('input');
      if (!token || !current.csrfParameter || !current.csrfToken) throw new Error('Logout token unavailable');
      token.name = current.csrfParameter;
      token.value = current.csrfToken;
      form.submit();
    } catch {
      setSignOutError('Could not sign out. Please try again.');
      setSigningOut(false);
    }
  }

  useEffect(() => {
    try {
      sessionStorage.setItem(cartStorageKey, JSON.stringify(cart));
    } catch {
      // Checkout still works when browser storage is unavailable.
    }
  }, [cart]);

  useEffect(() => {
    if (userId === null) return;
    const controller = new AbortController();
    setOrdersLoading(true);
    setOrdersError(false);
    request<OrderSummary[]>(`/api/checkout/users/${userId}/orders?offset=${orderPage * 20}`,
      { signal: controller.signal, cache: 'no-store' }).then(result => {
      if (!controller.signal.aborted) setOrders(result);
    }).catch(() => {
      if (!controller.signal.aborted) setOrdersError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setOrdersLoading(false);
    });
    return () => controller.abort();
  }, [request, userId, orderPage, orderRevision]);

  useEffect(() => {
    if (userId === null || selectedId === undefined || !cartKey) return;
    const controller = new AbortController();
    setQuoteFailed(false);
    const query = new URLSearchParams({ userId: String(userId), couponId: String(selectedId), cart: cartKey });
    request<Pricing>(`/api/checkout/quote?${query}`, { signal: controller.signal }).then((pricing) => {
      if (!controller.signal.aborted) setQuote({ couponId: selectedId, cartKey, pricing });
    }).catch(() => {
      if (!controller.signal.aborted) setQuoteFailed(true);
    });
    return () => controller.abort();
  }, [request, selectedId, cartKey, walletRevision, quoteRevision, userId]);

  function updateCart(next: CartLine[]) {
    if (cartLocked) return;
    setCart(next.map(({ productId, quantity, checked }) => ({ productId, quantity, checked })));
    if (selectedCartKey(next) !== cartKey) setQuote(undefined);
    setReceipt(undefined);
    setCheckoutError('');
    setShowCouponReminder(false);
  }

  function refresh() {
    setCheckoutError('');
    reloadCoupons();
  }

  function reloadCoupons() {
    setQuote(undefined);
    setShowCouponReminder(false);
    reloadWallet();
  }

  function chooseCoupon(id: number) {
    if (id === couponId) return;
    setCouponId(id);
    setQuote(undefined);
    setQuoteFailed(false);
    setReceipt(undefined);
    setCheckoutError('');
    setShowCouponReminder(false);
  }

  function addToCart(product: Product) {
    const existing = cart.find(line => line.productId === product.id);
    if (existing?.quantity === MAX_QUANTITY) return;
    const next = existing
      ? cart.map(line => line === existing ? { ...line, checked: true, quantity: line.quantity + 1 } : line)
      : [...cart, { productId: product.id, quantity: 1, checked: true }];
    updateCart(next);
    setCartNotice(`${product.name} added · ${(existing?.quantity ?? 0) + 1} in cart`);
  }

  async function claim(coupon: Coupon) {
    if (userId === null) return;
    setBusy(true);
    setNotice('');
    try {
      await client.claim(coupon.id, userId);
      setNotice('Coupon claimed. Updating your coupons…');
      // The Redis claim is visible in PostgreSQL after the Kafka consumer writes it.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const claims = await request<WalletCoupon[]>(walletPath, { cache: 'no-store' });
        setWallet(claims);
        if (claims.some((claim) => claim.coupon.id === coupon.id)) {
          setNotice('Coupon added to My coupons.');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      setNotice('Coupon claimed. Refresh My coupons to see it when it is ready.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function placeOrder(withoutCouponConfirmed = false) {
    if (submittingOrder.current || checkoutBlocked || (!pendingCheckout && !canStartCheckout)) return;
    if (!pendingCheckout && !selected && hasUsableCoupon && !withoutCouponConfirmed) {
      setShowCouponReminder(true);
      return;
    }
    const attempt = pendingCheckout ?? {
      orderId: crypto.randomUUID(),
      couponId: userId === null ? null : selected?.id ?? null,
      items: checkedLines.map(({ productId, quantity }) => ({ productId, quantity })),
    };
    if (!pendingCheckout) {
      try {
        savePendingCheckout(userId, attempt);
      } catch {
        setCheckoutError('Checkout needs browser session storage to safely submit your order.');
        return;
      }
      setPendingCheckout(attempt);
    }
    submittingOrder.current = true;
    setShowCouponReminder(false);
    setBusy(true);
    setCheckoutError('');
    try {
      const checkoutPath = userId === null ? '/api/checkout/guest/orders' : `/api/checkout/users/${userId}/orders`;
      const response = await request<Receipt>(`${checkoutPath}/${attempt.orderId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ couponId: attempt.couponId, items: attempt.items }),
      });
      const remaining = cart.filter(line => !line.checked || !attempt.items.some(item =>
        item.productId === line.productId && item.quantity === line.quantity));
      sessionStorage.setItem(cartStorageKey, JSON.stringify(remaining));
      clearPendingCheckout(userId);
      setPendingCheckout(undefined);
      setCart(remaining);
      setReceipt(response);
      setStockRevision(value => value + 1);
      setOrderPage(0);
      setOrderRevision(value => value + 1);
      setCartNotice('');
      if (attempt.couponId !== null) reloadCoupons();
      setCouponId(0);
      setQuote(undefined);
    } catch (error) {
      setCheckoutError(errorMessage(error));
      const code = error instanceof CouponApiError ? error.code : undefined;
      const couponRejected = code !== undefined && ['EXPIRED', 'ALREADY_REDEEMED', 'NOT_CLAIMED',
        'NOT_STARTED', 'NOT_ISSUED', 'COUPON_NOT_FOUND', 'BELOW_MIN_ORDER'].includes(code);
      if (code === 'INSUFFICIENT_STOCK' || couponRejected || (error instanceof CouponApiError && error.status === 400)) {
        clearPendingCheckout(userId);
        setPendingCheckout(undefined);
      }
      if (code === 'INSUFFICIENT_STOCK') {
        setStockRevision(value => value + 1);
      }
      if (couponRejected) {
        setCouponId(0);
        reloadCoupons();
      }
    } finally {
      submittingOrder.current = false;
      setBusy(false);
    }
  }

  async function updateDemoOrder(orderId: string, action: 'refund' | 'ship') {
    if (orderAction || userId === null) return;
    setOrderAction(orderId);
    setOrderActionError('');
    try {
      await request(`/api/checkout/users/${userId}/orders/${orderId}/${action}`, { method: 'POST' });
      setOrders(previous => previous.map(order => {
        if (order.orderId !== orderId) return order;
        return action === 'refund'
          ? { ...order, paymentStatus: 'REFUNDED' } : { ...order, shippingStatus: 'SHIPPED' };
      }));
      setStockRevision(value => value + 1);
    } catch (error) {
      setOrderActionError(errorMessage(error));
      setOrderRevision(value => value + 1);
    } finally {
      setOrderAction(undefined);
    }
  }

  return (
    <main className="page shop">
      <header className="shop-header">
        <div>
          <h1>Kitchenware Store</h1>
        </div>
        {session && (userId === null ? (
          <a className="shop-account" href={loginPath}>Sign in</a>
        ) : (
          <form className="shop-account-form" action="/logout" method="post" onSubmit={signOut}>
            <input type="hidden" />
            <button className="shop-sign-out" type="submit" disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
            {signOutError && <span role="alert">{signOutError}</span>}
          </form>
        ))}
      </header>
      <nav className="shop-nav" aria-label="Shop">
          <a href="#products">Shop</a>
          <a href="#offers">Offers</a>
          <a href="#wallet">My coupons</a>
          <a href="#checkout">Cart ({lines.reduce((count, line) => count + line.quantity, 0)})</a>
          <a href="#orders">My orders</a>
      </nav>
      <section className="card retail-catalog" id="products">
        <div className="retail-section-heading">
          <h2>Shop kitchenware</h2>
        </div>
        {products.length > 0 && <div className="retail-filters" role="group" aria-label="Category">
          {['', ...new Set(products.map(product => product.category).filter(Boolean))].map(name =>
            <button key={name} type="button" aria-pressed={category === name} onClick={() => setCategory(name)}>
              {name || 'All products'}
            </button>)}
        </div>}
        {productsLoad === 'loading' && products.length === 0 && <p>Loading products…</p>}
        {productsLoad === 'error' && <div>
          <p role="alert">Could not load products.</p>
          <button type="button" onClick={reloadProducts}>Retry products</button>
        </div>}
        <div className="retail-products">
          {products.filter(product => !category || product.category === category).map(product =>
            <article className="retail-product" key={product.id}>
              <button className="retail-product-preview" type="button"
                aria-label={`View ${product.name} details`} aria-haspopup="dialog"
                onClick={() => setDetailProduct(product)}>
                {productImages[product.id] && <img className="retail-photo" src={productImages[product.id]}
                  alt="" loading="lazy" decoding="async" />}
                <span>{product.name}</span>
              </button>
              <p>{product.category}</p>
              <p>{product.description}</p>
              <div><strong>{formatMoney(product.cents)}</strong>
                {stock[product.id] !== undefined && <p>{stock[product.id] === 0 ? 'Out of stock' : `${stock[product.id]} in stock`}</p>}
              </div>
              <button type="button" className="button-primary" disabled={cartLocked || Boolean(removeId)
                || stock[product.id] === 0
                || cart.some(line => line.productId === product.id && line.quantity === MAX_QUANTITY)}
                aria-label={`Add ${product.name} to cart`} onClick={() => addToCart(product)}>Add to cart</button>
            </article>)}
        </div>
        <p className="retail-photo-note">Product concept images. <a href="./photo-credits.html">Image credits</a></p>
        {cartNotice && <div className="retail-cart-notice">
          <p role="status">{cartNotice}</p><a href="#checkout">View cart</a>
        </div>}
      </section>
      <dialog className="retail-product-dialog" ref={productDialog} aria-labelledby="product-detail-title"
        onClose={() => setDetailProduct(undefined)}>
        <div className="retail-dialog-heading">
          <h2 id="product-detail-title">{detailProduct?.name}</h2>
          <form method="dialog"><button type="submit">Close</button></form>
        </div>
      </dialog>
      <div className="shop-layout">
        <div className="shop-column">
          <section className="card" id="offers">
            <h2>Available offers</h2>
            {offersLoad === 'loading' && <p>Loading offers…</p>}
            {offersLoad === 'error' && <div>
              <p role="alert">Could not load offers.</p>
              <button type="button" onClick={reloadOffers}>Retry offers</button>
            </div>}
            {notice && <p role="status">{notice}</p>}
            {offersLoad === 'ready' && !catalog.length && <p>No offers are active right now.</p>}
            <div className="shop-offer-list" id="offer-list">
            {visibleOffers.map((coupon) => {
              const status = walletStatus.get(coupon.id);
              const soldOut = coupon.remainingStock === 0 && !status;
              return <article className="shop-offer" key={coupon.id}>
                <div className="shop-offer-details">
                  <h3>{coupon.name}</h3>
                  {(coupon.discountAmount > 0 || coupon.giftName) && <p className="shop-offer-value">
                    {coupon.discountAmount > 0 && <span className="shop-offer-discount">{formatMoney(Math.round(coupon.discountAmount * 100))} off</span>}
                    {coupon.giftName && <span className="shop-offer-gift">{coupon.discountAmount > 0 ? '+ Free ' : 'Free '}{coupon.giftName}</span>}
                  </p>}
                  <p>Orders from {formatMoney(Math.round(coupon.minOrderAmount * 100))}</p>
                  <p>Ends <time dateTime={coupon.validUntil}>{new Date(coupon.validUntil).toLocaleDateString()}</time></p>
                  {recommended?.id === coupon.id && <p className="shop-recommended">
                    Recommended for {checkedLines.length === 1 ? checkedLines[0]?.product.name : 'selected items'}
                  </p>}
                </div>
                {userId === null && !soldOut && !status ? (
                  <a className="shop-claim shop-claim-login" href={loginPath}>
                    Sign in to claim
                  </a>
                ) : <button className="shop-claim" type="button" disabled={cartLocked || walletLoad === 'loading' || Boolean(status) || soldOut} onClick={() => void claim(coupon)}>
                  {status === 'REDEEMED' ? 'Used' : status ? 'Claimed' : soldOut ? 'Sold out' : 'Claim offer'}
                </button>}
              </article>;
            })}
            </div>
            {orderedOffers.length > initialOfferCount && (
              <button className="shop-offer-toggle" type="button" aria-controls="offer-list" aria-expanded={showAllOffers}
                onClick={() => setShowAllOffers(!showAllOffers)}>
                {showAllOffers ? 'Show fewer offers' : `Show all ${orderedOffers.length} offers`}
                <span aria-hidden="true">{showAllOffers ? '▴' : '▾'}</span>
              </button>
            )}
          </section>
          <section className="card" id="wallet">
            <div className="catalog-heading"><h2>My coupons</h2>
              {userId !== null && <button type="button" disabled={cartLocked || walletLoad === 'loading'} onClick={refresh}>Refresh</button>}
            </div>
            {userId === null
              ? <div className="shop-account-prompt"><p>See your claimed coupons and remaining uses.</p>
                  <a className="shop-text-action" href={loginPath}>Sign in to view coupons <span aria-hidden="true">→</span></a>
                </div>
              : !wallet.length && walletLoad === 'ready' && <p>Claim an offer to add it here.</p>}
            {userId !== null && walletLoad === 'error' && <p role="alert">Could not load your coupons. Use Refresh to try again.</p>}
            {wallet.length > 0 && available.length === 0 && <p>No coupons available right now.</p>}
            {available.map(({ coupon, remainingUses }) => <div className="shop-wallet-row" key={coupon.id}>
              <div className="shop-wallet-details">
                <strong>{coupon.name}</strong>
                <p>Ends {new Date(coupon.validUntil).toLocaleDateString()}</p>
                {(coupon.maxUsesPerUser ?? 1) > 1 && <p>{remainingUses} of {coupon.maxUsesPerUser} uses left</p>}
              </div>
              <button className="shop-use" type="button" disabled={cartLocked || walletLoad !== 'ready'}
                aria-label={`Use ${coupon.name} at checkout`}
                onClick={() => {
                  chooseCoupon(coupon.id);
                  couponTrigger.current?.focus();
                }}>Use at checkout</button>
            </div>)}
            {upcoming.map(({ coupon }) => <div className="shop-wallet-row" key={coupon.id}>
              <span>{coupon.name}</span><span>Upcoming</span>
            </div>)}
            {history.length > 0 && <details className="shop-wallet-history">
              <summary>Used and expired coupons ({history.length})</summary>
              {history.map(({ coupon, status }) => <div className="shop-wallet-row" key={coupon.id}>
                <span>{coupon.name}</span>
                <span>{status === 'REDEEMED' ? 'Used' : 'Expired'}</span>
              </div>)}
            </details>}
          </section>
        </div>
        <section className="card shop-checkout" id="checkout">
          <header className="shop-checkout-heading">
            <h2>Checkout</h2>
            <p>Demo order · No payment required</p>
          </header>
          <ShoppingCart
            lines={lines}
            disabled={cartLocked || productsLoad !== 'ready'}
            removeId={removeId}
            onRemoveChange={setRemoveId}
            onChange={updateCart}
          />
          <div className="shop-checkout-summary">
          <h3>Order summary</h3>
          {userId !== null && !pendingCheckout && <div className="shop-coupon-picker">
            <span id="coupon-label">Coupon</span>
            <details ref={couponPicker} onKeyDown={event => {
              if (event.key === 'Escape' && event.currentTarget.open) {
                event.currentTarget.open = false;
                couponTrigger.current?.focus();
              }
            }}>
              <summary ref={couponTrigger} aria-labelledby="coupon-label coupon-value">
                <span id="coupon-value">{selected?.name ?? 'No coupon selected'}</span>
              </summary>
              <div className="shop-coupon-options" role="group" aria-label="Coupon choices">
                {[{ id: 0, name: 'No coupon selected' }, ...available.map(({ coupon }) => coupon)].map(option =>
                  <button key={option.id} type="button" disabled={cartLocked || walletLoad !== 'ready'}
                    aria-pressed={(selectedId ?? 0) === option.id} onClick={() => {
                      chooseCoupon(option.id);
                      couponPicker.current?.removeAttribute('open');
                      couponTrigger.current?.focus();
                    }}>{option.name}</button>)}
              </div>
            </details>
          </div>}
          {!pendingCheckout && selected && cartKey && <div className={currentQuote?.result === 'BELOW_MIN_ORDER'
            ? 'shop-eligibility shop-eligibility--below-minimum' : 'shop-eligibility'} role="status">
            <p>{currentQuote ? copyFor(currentQuote.result).message
              : quoteFailed ? 'Could not check this coupon.' : 'Checking coupon eligibility…'}</p>
            {shortfall > 0 && <p>{formatMoney(shortfall)} away from the minimum.</p>}
            {quoteFailed && <button type="button" onClick={() => {
              setQuoteFailed(false);
              setQuoteRevision(value => value + 1);
            }}>Retry coupon check</button>}
          </div>}
          {currentQuote?.giftName && <p className="shop-gift">Included free · {currentQuote.giftName}</p>}
          {!pendingCheckout && <dl className="shop-total" aria-label="Order totals">
            <div><dt>Subtotal</dt><dd>{formatMoney(subtotal)}</dd></div>
            {discount > 0 && <div key={discount} className="shop-savings">
              <dt>You save</dt>
              <dd>−{formatMoney(discount)}</dd>
            </div>}
            <div><dt>Total</dt><dd>{formatMoney(currentQuote?.totalCents ?? subtotal)}</dd></div>
          </dl>}
          {pendingCheckout ? <div className="shop-coupon-reminder">
            <p role="status">{busy ? 'Checking your order…' : 'Your last order has no confirmation yet. Retry to check it before changing your cart.'}</p>
            <button className="button-primary" type="button" disabled={busy} onClick={() => void placeOrder()}>Retry order</button>
          </div> : showCouponReminder ? <div className="shop-coupon-reminder">
            <p role="status">You have a coupon available for this order.</p>
            <div className="shop-reminder-actions">
              <button type="button" onClick={() => {
                setShowCouponReminder(false);
                couponPicker.current?.setAttribute('open', '');
                couponTrigger.current?.focus();
              }}>Choose a coupon</button>
              <button type="button" disabled={!canStartCheckout}
                onClick={() => void placeOrder(true)}>Continue without a coupon</button>
            </div>
          </div> : userId === null ? <div className="shop-guest-checkout">
            <p>Sign in to use coupons.</p>
            <a href={loginPath}>Sign in</a>
            <button className="button-primary" type="button" disabled={!canStartCheckout}
              onClick={() => void placeOrder()}>Continue as guest</button>
          </div> : <button className="button-primary" type="button"
            disabled={!canStartCheckout}
            aria-label="Confirm demo order"
            onClick={() => void placeOrder()}>
              <span>Confirm demo order</span><strong aria-hidden="true">{formatMoney(currentQuote?.totalCents ?? subtotal)}</strong>
            </button>}
          {!cartKey && lines.length > 0 && <p>Select items to continue.</p>}
          {checkoutError && <p role="alert">{checkoutError}</p>}
          {receipt && <p className="shop-receipt" role="status">
            Order confirmed for {formatMoney(receipt.pricing.totalCents)}. Simulated payment complete.
            {receipt.pricing.result === 'REDEEMED' && ' Coupon used.'}<br />
            {receipt.pricing.giftName && <>Free gift · {receipt.pricing.giftName}<br /></>}
            <small>demo-{receipt.orderId}</small>
            {userId !== null && <><br /><a href="#orders">View my orders</a></>}
          </p>}
          </div>
        </section>
      </div>
      <section className="card retail-orders" id="orders">
        <h2>My orders</h2>
        {orderActionError && <p role="alert">{orderActionError}</p>}
        {userId === null && <div className="shop-account-prompt"><p>Find your past orders and receipts here.</p>
          <a className="shop-text-action" href={loginPath}>Sign in to view orders <span aria-hidden="true">→</span></a>
        </div>}
        {ordersLoading && <p role="status">Loading orders…</p>}
        {ordersError && <p role="alert">Could not load orders. <button type="button"
          onClick={() => setOrderRevision(value => value + 1)}>Retry</button></p>}
        {userId !== null && !ordersLoading && !ordersError && orders.length === 0 &&
          <p>{orderPage === 0 ? 'You have no orders yet.' : 'There are no more orders.'}</p>}
        {!ordersLoading && !ordersError && orders.map(order => <details className="retail-order" key={order.orderId}>
          <summary>
            <span>Order {order.orderId.slice(0, 8)} · {new Date(order.createdAt).toLocaleDateString()}</span>
            <strong>{formatMoney(order.pricing.totalCents)}</strong>
          </summary>
          <ul>{order.items.map(item => <li key={item.name}>{item.quantity} × {item.name}</li>)}</ul>
          <dl className="shop-total">
            <div><dt>Subtotal</dt><dd>{formatMoney(order.pricing.subtotalCents)}</dd></div>
            <div><dt>Discount</dt><dd>{formatMoney(order.pricing.discountCents)}</dd></div>
            <div><dt>Total</dt><dd>{formatMoney(order.pricing.totalCents)}</dd></div>
          </dl>
          {order.pricing.giftName && <p>Free gift · {order.pricing.giftName}</p>}
          {order.paymentStatus !== 'DEMO' && <div className="shop-order-status">
            <p>{order.paymentStatus === 'REFUNDED' ? 'Refunded · simulated' : 'Paid · simulated'}</p>
            <p>{order.shippingStatus === 'SHIPPED' ? 'Shipped · simulated' : 'Not shipped'}</p>
            {order.paymentStatus === 'PAID' && order.shippingStatus === 'UNSHIPPED' && <div className="shop-reminder-actions">
              <button type="button" disabled={Boolean(orderAction)} onClick={() => void updateDemoOrder(order.orderId, 'refund')}>Simulate refund</button>
              <button type="button" disabled={Boolean(orderAction)} onClick={() => void updateDemoOrder(order.orderId, 'ship')}>Simulate shipment</button>
            </div>}
          </div>}
        </details>)}
        {userId !== null && (orderPage > 0 || orders.length === 20) && <div className="retail-order-pages">
          <button type="button" disabled={ordersLoading || orderPage === 0}
            onClick={() => setOrderPage(page => page - 1)}>Newer orders</button>
          <button type="button" disabled={ordersLoading || ordersError || orders.length < 20}
            onClick={() => setOrderPage(page => page + 1)}>Older orders</button>
        </div>}
      </section>
    </main>
  );
}
