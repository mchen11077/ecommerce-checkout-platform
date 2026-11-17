import { MAX_QUANTITY, type CartLine } from '../cart';
import { formatMoney } from '../formatMoney';

interface Props {
  lines: (CartLine & { product: { name: string; cents: number } })[];
  disabled: boolean;
  removeId?: string;
  onRemoveChange: (productId?: string) => void;
  onChange: (lines: CartLine[]) => void;
}

export function ShoppingCart({ lines, disabled, removeId, onRemoveChange, onChange }: Props) {
  const selected = lines.filter(line => line.checked);
  const allSelected = lines.length > 0 && selected.length === lines.length;
  const selectedQuantity = selected.reduce((total, line) => total + line.quantity, 0);

  function updateLine(productId: string, change: Partial<Pick<CartLine, 'checked' | 'quantity'>>) {
    onChange(lines.map(line => line.productId === productId ? { ...line, ...change } : line));
  }

  return (
    <fieldset disabled={disabled}>
      <legend>Shopping cart</legend>
      {lines.length === 0 ? (
        <>
          <p>Your cart is empty.</p>
          <a href="#products">Browse products</a>
        </>
      ) : (
        <div className="shop-cart-toolbar">
          <label className="shop-select-all">
            <input type="checkbox" checked={allSelected} ref={input => {
              if (input) input.indeterminate = selected.length > 0 && !allSelected;
            }} onChange={event => {
              const checked = event.currentTarget.checked;
              onChange(lines.map(line => ({ ...line, checked })));
            }} />
            Select all items
          </label>
          <span aria-live="polite">{selectedQuantity} selected</span>
        </div>
      )}
      {lines.map(({ product, productId, quantity, checked }) => (
        <div className="shop-product" key={productId}>
          <label>
            <input type="checkbox" checked={checked}
              onChange={event => updateLine(productId, { checked: event.currentTarget.checked })} />
            <span className="shop-product-name">
              <strong>{product.name}</strong>
              <small>{formatMoney(product.cents)} each</small>
            </span>
          </label>
          <strong className="shop-line-total">{formatMoney(product.cents * quantity)}</strong>
          <div className="shop-cart-controls">
            <div className="shop-quantity">
              <button type="button" aria-label={`Decrease ${product.name} quantity`}
                disabled={quantity === 1 || Boolean(removeId)}
                onClick={() => updateLine(productId, { quantity: quantity - 1 })}>−</button>
              <span aria-label={`${product.name} quantity`}>{quantity}</span>
              <button type="button" aria-label={`Increase ${product.name} quantity`}
                disabled={quantity === MAX_QUANTITY || Boolean(removeId)}
                onClick={() => updateLine(productId, { quantity: quantity + 1 })}>+</button>
            </div>
            <button className="shop-cart-remove" type="button" aria-label={`Remove ${product.name}`}
              disabled={Boolean(removeId)} onClick={() => onRemoveChange(productId)}>Remove</button>
          </div>
          {removeId === productId && (
            <div className="shop-cart-confirm" role="group" aria-label={`Remove ${product.name}?`}>
              <p>Remove {product.name} from your cart?</p>
              <button type="button" onClick={() => onRemoveChange()}>Keep item</button>
              <button type="button" onClick={() => {
                onChange(lines.filter(line => line.productId !== productId));
                onRemoveChange();
              }}>Confirm removal</button>
            </div>
          )}
        </div>
      ))}
    </fieldset>
  );
}
