const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatMoney(cents: number) {
  return dollars.format(cents / 100);
}
