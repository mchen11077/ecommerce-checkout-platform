export interface CheckoutItem {
  productId: string;
  quantity: number;
}

export interface PendingCheckout {
  orderId: string;
  couponId: number | null;
  items: CheckoutItem[];
}

function key(owner: number | null) {
  return `kitchenware-checkout-v1:${owner ?? 'guest'}`;
}

export function readPendingCheckout(owner: number | null): PendingCheckout | undefined {
  try {
    const stored = JSON.parse(sessionStorage.getItem(key(owner)) ?? 'null') as PendingCheckout | null;
    if (!stored || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stored.orderId) ||
      (stored.couponId !== null && (!Number.isSafeInteger(stored.couponId) || stored.couponId < 1 || owner === null)) ||
      !Array.isArray(stored.items) || !stored.items.length ||
      stored.items.some(item => !item || typeof item.productId !== 'string' || !item.productId ||
        !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) ||
      new Set(stored.items.map(item => item.productId)).size !== stored.items.length) return undefined;
    return stored;
  } catch {
    return undefined;
  }
}

export function savePendingCheckout(owner: number | null, attempt: PendingCheckout) {
  sessionStorage.setItem(key(owner), JSON.stringify(attempt));
}

export function clearPendingCheckout(owner: number | null) {
  sessionStorage.removeItem(key(owner));
}
