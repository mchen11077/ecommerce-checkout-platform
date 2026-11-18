import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CouponApiError } from '@xumeiqi/coupon-client';
import { isCartQuantity, MAX_QUANTITY, type CartLine } from './cart';
import { ShoppingCart } from './components/ShoppingCart';
import { formatMoney } from './formatMoney';
import { copyFor } from './messages';
import { clearPendingCheckout, readPendingCheckout, savePendingCheckout } from './pendingCheckout';
import { useResourceList } from './useResourceList';
import { useShopApi, type BrowserSession } from './useShopApi';
import { ChoicePicker } from './components/ChoicePicker';
export type { BrowserSession } from './useShopApi';
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

interface Product {
  id: string; name: string; cents: number; category: string; description: string;
  details?: { dimensions: string; material: string; care: string[] };
}
interface Receipt { orderId: string; pricing: Pricing }
interface OrderSummary extends Receipt {
  createdAt: string;
  items: { name: string; quantity: number }[];
  paymentStatus: 'DEMO' | 'PAID' | 'REFUNDED';
  shippingStatus: 'UNSHIPPED' | 'SHIPPED';
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
  return error instanceof CouponApiError ? copyFor(error.code).message : 'Could not reach the shop. Please try again.';
}

export default function Shop({ session }: { session?: BrowserSession } = {}) {
  const userId = session ? (session.userId === null ? null : Number(session.userId)) : 101;
  const walletPath = `/api/users/${userId}/coupons`;
  const { client, request, sessionExpired } = useShopApi(session, configuredApi);
  const { items: products, status: productsLoad, reload: reloadProducts } =
    useResourceList<Product>(request, '/api/checkout/products');
  const { items: catalog, status: offersLoad, reload: reloadOffers } =
    useResourceList<Coupon>(request, '/api/coupons');
  const { items: wallet, status: walletLoad, setItems: setWallet, revision: walletRevision, reload: reloadWallet } =
    useResourceList<WalletCoupon>(request, userId === null ? null : walletPath, 'no-store');
  const [showAllOffers, setShowAllOffers] = useState(false);
  const [cart, setCart] = useState(readCart);
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('featured');
  const filteredProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const filtered = products.filter(product => (!category || product.category === category)
      && [product.name, product.category, product.description].join(' ').toLocaleLowerCase().includes(query));
    if (sort !== 'featured') filtered.sort((a, b) =>
      (sort === 'price-asc' ? a.cents - b.cents : b.cents - a.cents) || a.name.localeCompare(b.name));
    return filtered;
  }, [products, category, search, sort]);
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
  const [failedOrderAction, setFailedOrderAction] = useState<{ orderId: string; action: 'refund' | 'ship' }>();
  const orderActionInFlight = useRef(false);
  const [orderFilter, setOrderFilter] = useState('ALL');
  const [hasMoreOrders, setHasMoreOrders] = useState(false);
  const [orderPage, setOrderPage] = useState(0);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState(false);
  const [orderRevision, setOrderRevision] = useState(0);
  const orderPhotos = new Map(products.map(product => [product.name, productImages[product.id]]));
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
  const [couponTime, setCouponTime] = useState(Date.now);
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

  const isExpired = (coupon: Coupon) => Date.parse(coupon.validUntil) <= couponTime;
  const available = wallet.filter(({ status, coupon }) => status === 'AVAILABLE' && !isExpired(coupon))
    .sort((a, b) => Date.parse(a.coupon.validUntil) - Date.parse(b.coupon.validUntil) || b.coupon.id - a.coupon.id);
  const upcoming = wallet.filter(({ status }) => status === 'UPCOMING');
  const history = wallet.filter(({ status, coupon }) => status === 'REDEEMED' || status === 'EXPIRED' || isExpired(coupon));
  const selected = wallet.find(({ coupon }) => coupon.id === couponId)?.coupon;
  const selectedId = selected?.id;
  const lines = products.flatMap(product => {
    const line = cart.find(item => item.productId === product.id);
    return line ? [{ ...line, product }] : [];
  });
  const checkedLines = lines.filter(line => line.checked);
  const cartKey = selectedCartKey(lines);
  const cartSubtotal = checkedLines.reduce((sum, line) => sum + line.product.cents * line.quantity, 0);
  const currentQuote: Pricing | undefined = selected && isExpired(selected) ? { result: 'EXPIRED', subtotalCents: cartSubtotal,
    discountCents: 0, totalCents: cartSubtotal, shortfallCents: 0 }
    : quote?.couponId === selectedId && quote?.cartKey === cartKey ? quote?.pricing : undefined;
  const checkoutBlocked = busy || Boolean(removeId) || sessionExpired;
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
    return !isExpired(coupon) && (status ? status === 'AVAILABLE' : coupon.remainingStock !== 0)
      && (coupon.discountAmount > 0 || coupon.giftName);
  });
  const recommended = cartKey ? candidates.filter(coupon => minimumShortfall(coupon, cartSubtotal) === 0)
    .sort((a, b) => Math.min(b.discountAmount, cartSubtotal / 100) - Math.min(a.discountAmount, cartSubtotal / 100)
      || Number(Boolean(b.giftName)) - Number(Boolean(a.giftName)))[0]
    : undefined;
  const orderedOffers = recommended ? [recommended, ...catalog.filter(coupon => coupon.id !== recommended.id)] : catalog;
  const visibleOffers = showAllOffers ? orderedOffers : orderedOffers.slice(0, initialOfferCount);

  useEffect(() => {
    if (!selected || pendingCheckout) return;
    const expiresAt = Date.parse(selected.validUntil);
    if (!Number.isFinite(expiresAt) || expiresAt <= couponTime) return;
    const check = () => setCouponTime(Date.now());
    const timer = setTimeout(check, Math.min(Math.max(0, expiresAt - Date.now()) + 10, 2_147_483_647));
    window.addEventListener('focus', check);
    return () => { clearTimeout(timer); window.removeEventListener('focus', check); };
  }, [selectedId, selected?.validUntil, pendingCheckout, couponTime]);

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
    request<OrderSummary[]>(`/api/checkout/users/${userId}/orders?offset=${orderPage * 20}&limit=21&status=${orderFilter}`,
      { signal: controller.signal, cache: 'no-store' }).then(result => {
      if (!controller.signal.aborted) {
        if (!result.length && orderPage > 0) { setOrderPage(page => page - 1); return; }
        setOrders(result.slice(0, 20));
        setHasMoreOrders(result.length > 20);
      }
    }).catch(() => {
      if (!controller.signal.aborted) setOrdersError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setOrdersLoading(false);
    });
    return () => controller.abort();
  }, [request, userId, orderPage, orderFilter, orderRevision]);

  useEffect(() => {
    if (userId === null || selectedId === undefined || !cartKey) return;
    const controller = new AbortController();
    setQuoteFailed(false);
    const query = new URLSearchParams({ userId: String(userId), couponId: String(selectedId), cart: cartKey });
    request<Pricing>(`/api/checkout/quote?${query}`, { signal: controller.signal, cache: 'no-store' }).then((pricing) => {
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
    if (userId === null || sessionExpired) return;
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
    if (orderActionInFlight.current || userId === null || sessionExpired) return;
    orderActionInFlight.current = true;
    setOrderAction(orderId);
    setOrderActionError('');
    setFailedOrderAction(undefined);
    try {
      await request(`/api/checkout/users/${userId}/orders/${orderId}/${action}`, { method: 'POST' });
      setOrders(previous => previous.map(order => {
        if (order.orderId !== orderId) return order;
        return action === 'refund'
          ? { ...order, paymentStatus: 'REFUNDED' } : { ...order, shippingStatus: 'SHIPPED' };
      }));
      setStockRevision(value => value + 1);
      setOrderRevision(value => value + 1);
    } catch (error) {
      const retryable = !(error instanceof CouponApiError) || error.status >= 500 || error.status === 429;
      setOrderActionError(retryable ? 'Could not confirm this update. Retry to check its outcome safely.' : errorMessage(error));
      if (retryable) setFailedOrderAction({ orderId, action });
      setOrderRevision(value => value + 1);
    } finally {
      orderActionInFlight.current = false;
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
      {sessionExpired && <div className="shop-session-alert" role="alert">
        <p>Your session has expired or changed. Your cart and pending order are saved.</p>
        <a className="shop-text-action" href={loginPath}>Sign in again</a>
      </div>}
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
        {products.length > 0 && <div className="retail-catalog-tools">
          <label className="retail-search">Search products
            <input type="search" value={search} placeholder="Search kitchenware" onChange={event => setSearch(event.target.value)} />
          </label>
          <ChoicePicker label="Sort products" value={sort} onChange={setSort} options={[
            { value: 'featured', label: 'Featured' }, { value: 'price-asc', label: 'Price: low to high' },
            { value: 'price-desc', label: 'Price: high to low' },
          ]} />
          <p role="status">{filteredProducts.length} {filteredProducts.length === 1 ? 'product' : 'products'}</p>
        </div>}
        {productsLoad === 'loading'  && products.length === 0 && <p>Loading products…</p>}
        {productsLoad === 'error' && <div>
          <p role="alert">Could not load products.</p>
          <button type="button" onClick={reloadProducts}>Retry products</button>
        </div>}
        <div className="retail-products">
          {filteredProducts.map(product =>
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
        {productsLoad === 'ready' && products.length > 0 && filteredProducts.length === 0 && <div className="retail-empty">
          <p>No products match your search and category.</p>
          <button type="button" onClick={() => { setSearch(''); setCategory(''); }}>Clear filters</button>
        </div>}
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
        {detailProduct && <div className="retail-detail-content">
          {productImages[detailProduct.id] && <img src={productImages[detailProduct.id]} alt={detailProduct.name} />}
          <div>
            <p>{detailProduct.category}</p><p>{detailProduct.description}</p>
            <strong className="retail-detail-price">{formatMoney(detailProduct.cents)}</strong>
            {detailProduct.details && <>
              <dl><dt>Size and capacity</dt><dd>{detailProduct.details.dimensions}</dd>
                <dt>Materials</dt><dd>{detailProduct.details.material}</dd></dl>
              <h3>Care instructions</h3><ul>{detailProduct.details.care.map(tip => <li key={tip}>{tip}</li>)}</ul>
            </>}
            {stock[detailProduct.id] !== undefined && <p>{stock[detailProduct.id] === 0 ? 'Out of stock' : `${stock[detailProduct.id]} in stock`}</p>}
            <button type="button" className="button-primary" disabled={cartLocked || Boolean(removeId)
              || stock[detailProduct.id] === 0 || cart.some(line => line.productId === detailProduct.id && line.quantity === MAX_QUANTITY)}
              onClick={() => { addToCart(detailProduct); productDialog.current?.close(); }}>Add to cart</button>
          </div>
        </div>}
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
                ) : <button className="shop-claim" type="button" disabled={cartLocked || sessionExpired || walletLoad === 'loading' || Boolean(status) || soldOut} onClick={() => void claim(coupon)}>
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
              {userId !== null && <button type="button" disabled={cartLocked || sessionExpired || walletLoad === 'loading'} onClick={refresh}>Refresh</button>}
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
              <button className="shop-use" type="button" disabled={cartLocked || sessionExpired || walletLoad !== 'ready'}
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
                  <button key={option.id} type="button" disabled={cartLocked || sessionExpired || walletLoad !== 'ready'}
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
            {quoteFailed && <button type="button" disabled={sessionExpired} onClick={() => {
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
            <button className="button-primary" type="button" disabled={busy || sessionExpired} onClick={() => void placeOrder()}>Retry order</button>
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
      <section className="card retail-orders" id="orders" aria-busy={ordersLoading}>
        <h2>My orders</h2>
        {userId !== null && <ChoicePicker label="Order status" value={orderFilter} disabled={Boolean(orderAction)}
          onChange={value => { if (value !== orderFilter) { setOrders([]); setOrderFilter(value); setOrderPage(0); } }} options={[
            { value: 'ALL', label: 'All orders' }, { value: 'UNSHIPPED', label: 'Awaiting shipment' },
            { value: 'SHIPPED', label: 'Shipped' }, { value: 'REFUNDED', label: 'Refunded' },
          ]} />}
        {orderActionError && <div className="retail-action-error" role="alert"><p>{orderActionError}</p>
          {failedOrderAction && <button type="button" disabled={Boolean(orderAction) || sessionExpired}
            onClick={() => void updateDemoOrder(failedOrderAction.orderId, failedOrderAction.action)}>
            Retry {failedOrderAction.action === 'refund' ? 'refund' : 'shipment'}
          </button>}
        </div>}
        {orderAction && <p role="status">Updating order…</p>}
        {userId === null && <div className="shop-account-prompt"><p>Find your past orders and receipts here.</p>
          <a className="shop-text-action" href={loginPath}>Sign in to view orders <span aria-hidden="true">→</span></a>
        </div>}
        {ordersLoading && <p role="status">Loading orders…</p>}
        {ordersError && <p role="alert">Could not load orders. <button type="button"
          onClick={() => setOrderRevision(value => value + 1)}>Retry</button></p>}
        {userId !== null && !ordersLoading && !ordersError && orders.length === 0 &&
          <p>{orderFilter !== 'ALL' ? 'No orders match this status.' : orderPage === 0 ? 'You have no orders yet.' : 'There are no more orders.'}</p>}
        {!ordersError && orders.map(order => <details className="retail-order" key={order.orderId}>
          <summary>
            <span className="retail-order-heading">
              <b>Order {order.orderId.slice(0, 8)}</b>
              <time dateTime={order.createdAt}>{new Date(order.createdAt).toLocaleDateString()}</time>
            </span>
            <strong>{formatMoney(order.pricing.totalCents)}</strong>
          </summary>
          <div className="retail-order-details">
            <div>
              <ul className="retail-order-items" aria-label="Items in the order">
                {order.items.map(item => {
                  const photo = orderPhotos.get(item.name);
                  return <li key={item.name}>
                    {photo && <img src={photo} alt="" width={56} height={56} loading="lazy" />}
                    <span><small>{item.quantity} ×</small> <strong>{item.name}</strong></span>
                  </li>;
                })}
              </ul>
              {order.pricing.giftName && <p className="shop-gift">Free gift · {order.pricing.giftName}</p>}
            </div>
            <div className="retail-order-receipt">
              <dl className="shop-total">
                <div><dt>Subtotal</dt><dd>{formatMoney(order.pricing.subtotalCents)}</dd></div>
                {order.pricing.discountCents > 0 && <div className="retail-order-discount">
                  <dt>Coupon discount</dt><dd>−{formatMoney(order.pricing.discountCents)}</dd>
                </div>}
                <div><dt>Total</dt><dd>{formatMoney(order.pricing.totalCents)}</dd></div>
              </dl>
              {order.paymentStatus !== 'DEMO' && <>
                <div className="retail-order-status">
                  <span data-state={order.paymentStatus}>{order.paymentStatus === 'REFUNDED' ? 'Refunded · simulated' : 'Paid · simulated'}</span>
                  <span data-state={order.shippingStatus}>{order.shippingStatus === 'SHIPPED' ? 'Shipped · simulated' : 'Not shipped'}</span>
                </div>
                {order.paymentStatus === 'PAID' && order.shippingStatus === 'UNSHIPPED' && <div className="shop-reminder-actions">
                  <button type="button" disabled={Boolean(orderAction) || sessionExpired} onClick={() => void updateDemoOrder(order.orderId, 'refund')}>Simulate refund</button>
                  <button type="button" disabled={Boolean(orderAction) || sessionExpired} onClick={() => void updateDemoOrder(order.orderId, 'ship')}>Simulate shipment</button>
                </div>}
              </>}
            </div>
          </div>
        </details>)}
        {userId !== null && (orderPage > 0 || hasMoreOrders) && <div className="retail-order-pages">
          <button type="button" disabled={ordersLoading || Boolean(orderAction) || orderPage === 0}
            onClick={() => { setOrders([]); setOrderPage(page => page - 1); }}>Newer orders</button>
          <span aria-live="polite">Page {orderPage + 1}</span>
          <button type="button" disabled={ordersLoading || Boolean(orderAction) || ordersError || !hasMoreOrders}
            onClick={() => { setOrders([]); setOrderPage(page => page + 1); }}>Older orders</button>
        </div>}
      </section>
    </main>
  );
}
