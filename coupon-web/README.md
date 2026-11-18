# Storefront

The React storefront renders the product catalog, cart, coupon wallet, checkout, and order history. Spring Boot validates coupon eligibility, calculates the final price, and records the order.

## Local development

From the repository root, start the API with `docker compose up -d --build postgres redis kafka app`. Then run:

```sh
pnpm --dir coupon-client install --frozen-lockfile
pnpm --dir coupon-client build
pnpm --dir coupon-web install --frozen-lockfile
pnpm --dir coupon-web dev
```

Vite serves the storefront on [localhost:5173](http://localhost:5173) and proxies API requests to `http://127.0.0.1:8080`. Use `COUPON_VITE_BACKEND` to change the proxy target. The local development storefront uses fixture customer 101. The [Docker storefront](../README.md#run-the-demo) uses Keycloak sessions and supports guest checkout.

For local coupon API diagnostics, open `/?debug=1` in Vite development mode.

## Tests and build

```sh
pnpm --dir coupon-web test
pnpm --dir coupon-web build
```

`Shop.test.tsx` covers coupon eligibility and checkout, wallet ordering, and partial cart checkout with removal confirmation. `App.test.tsx` covers the local diagnostics page.
