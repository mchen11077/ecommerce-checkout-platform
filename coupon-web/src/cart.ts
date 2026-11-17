export const MAX_QUANTITY = 99;

export interface CartItem {
  productId: string;
  quantity: number;
}

export interface CartLine extends CartItem {
  checked: boolean;
}

export function isCartQuantity(quantity: number) {
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_QUANTITY;
}
