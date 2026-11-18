# E-Commerce Checkout Platform

A full-stack kitchenware storefront with coupon management and transactional checkout. Built with React, TypeScript, and Spring Boot. Payments, refunds, and shipping are simulated.

[Quick start](#quick-start) · [Technical design](#technical-design) · [QA report](docs/QA_REPORT.md) · [Benchmarks](perf/README.md)

## Highlights

- Browse products, manage a cart, and check out selected items as a guest or signed-in customer.
- Claim coupons, check spending requirements, and apply discounts or gifts to an order.
- Recover a checkout after a lost response or same-tab refresh without creating another order or deducting stock twice.
- Review orders and simulate refunds or shipment, with inventory restored once on a successful refund.

## Preview

<table>
  <tr>
    <th>Cart and checkout</th>
    <th>Order history</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/checkout.png" alt="Two selected products with a $10 coupon and a $65 total" width="480"></td>
    <td><img src="docs/screenshots/orders.png" alt="Order details with product images, receipt totals, and refund and shipment controls" width="480"></td>
  </tr>
</table>

## Tech stack

| Layer | Technologies |
| --- | --- |
| Frontend | React 19, TypeScript, Vite |
| Backend | Java 21, Spring Boot, Spring Security, JDBC |
| Data and authentication | PostgreSQL, Keycloak / OpenID Connect |
| Claim experiments | Redis, Kafka, k6 |
| Testing and tooling | JUnit, Vitest, Playwright, JaCoCo, Docker Compose, GitHub Actions |

## Quick start

**Requirements:** Docker with Compose v2. The command below works in Bash and PowerShell; Java and Node.js run inside the build containers.

From the repository root:

```sh
docker compose --project-directory . -p ecommerce-demo --env-file deploy/rehearsal.env -f deploy/docker-compose.release.yml -f deploy/docker-compose.rehearsal.yml up -d --build postgres keycloak migrate app web seed
```

Open [localhost:5186](http://localhost:5186). Use `shopper-a` / `LocalShopperA-201!` to sign in to the local demo.

Try this workflow: add the **$50 skillet** and **$25 utensil set**, claim **Kitchen starter savings**, and apply it at checkout. The **$10 discount** brings the total to **$65**. Open **My orders** to review the receipt and try a refund or shipment.

<details>
<summary>Stop the demo</summary>

```sh
docker compose --project-directory . -p ecommerce-demo --env-file deploy/rehearsal.env -f deploy/docker-compose.release.yml -f deploy/docker-compose.rehearsal.yml stop
```

</details>

## Technical design

Nginx serves the React storefront and proxies the Spring Boot API. Keycloak handles sign-in. PostgreSQL stores product inventory, coupon claims, and orders.

| Scenario | Implementation |
| --- | --- |
| Checkout response is lost | The browser preserves the original request. A unique `(user_id, order_id)` constraint allows a retry to return the existing receipt. |
| An item is out of stock | Conditional stock updates and order creation share one transaction. A rejected item rolls back earlier deductions. |
| Refund and shipment arrive together | Both operations lock the order with `SELECT ... FOR UPDATE` before changing its state. |
| Another account requests an order | The API validates account ownership. Session-based writes also require CSRF protection. |

## Tests

[CI](.github/workflows/coupon.yml) runs Java and frontend tests, PostgreSQL integration checks, and browser tests in Chromium and WebKit. The backend job publishes JaCoCo coverage.

The [QA report](docs/QA_REPORT.md) records the latest local results and line and branch coverage. The [feature matrix](docs/FEATURE_MATRIX.md) identifies verified workflows and remaining gaps, including physical-device testing.

## Further documentation

- [Frontend setup and component tests](coupon-web/README.md)
- [TypeScript coupon client](coupon-client/README.md)
- [Deployment configuration and release rehearsal](deploy/README.md)
- [Coupon claim implementations](docs/claim-experiments.md)

## Image credits

Product images are AI-generated concepts. See [image credits](coupon-web/public/photo-credits.html) for attribution and reference-photo licenses.
