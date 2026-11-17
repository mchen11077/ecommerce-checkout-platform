# Paw & Pantry — Full-Stack E-Commerce Platform

A full-stack coupon and checkout project with **Paw & Pantry**, a kitchenware storefront. Shoppers can browse products, claim offers, check out with selected cart items, and view their orders. Payment, refunds, and shipment are simulated.

## Engineering highlights

| Scenario | Behavior |
| --- | --- |
| Checkout response is lost | The browser retries with the same order ID and cart contents. The server returns the existing receipt and deducts stock once. |
| A later cart item is out of stock | PostgreSQL rolls back the order and earlier inventory updates. Any coupon remains available for a retry. |
| Refund and shipment race | An order row lock serializes the actions. Exactly one succeeds, and a refund restores stock once. |
| Coupon offers are unavailable | The product catalog stays usable. Shoppers can retry loading offers separately. |

**Stack:** React, TypeScript, Spring Boot, Java 21, PostgreSQL, Keycloak, and Docker Compose. A separate load-test setup uses Redis, Kafka, nginx, and k6 to compare coupon-claim implementations.

## Run locally

Start Docker Desktop, then run from the repository root in PowerShell.

```powershell
$compose = @('--project-directory', '.', '-p', 'coupon-demo', '--env-file', 'deploy/rehearsal.env',
  '-f', 'deploy/docker-compose.release.yml', '-f', 'deploy/docker-compose.rehearsal.yml')
docker compose @compose up -d --build postgres keycloak migrate app web
Get-Content -Raw deploy/retail-offers.sql |
  docker compose @compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U coupon -d coupon
```

Open **http://localhost:5186**. Rehearsal accounts are defined in the [local identity fixture](deploy/keycloak/coupons-realm.json). For a quick demo, add the $50 skillet and $25 utensil set, then apply **Kitchen starter savings**. The $10 discount brings the total to **$65**.

```powershell
docker compose @compose stop
```

## Tests and documentation

- [GitHub Actions workflow](.github/workflows/coupon.yml) runs Java and TypeScript tests, checkout API integration checks, and a browser rehearsal.
- [PostgreSQL checkout tests](app/src/test/java/com/coursework/coupon/CheckoutPostgresTest.java) cover rollback and both outcomes of a refund/shipment race. Set `CHECKOUT_TEST_JDBC_URL`, `CHECKOUT_TEST_DB_USER`, and `CHECKOUT_TEST_DB_PASSWORD` to a disposable database before running `mvn test` in `app`.
- [Coupon claim experiments](docs/claim-experiments.md) documents the Redis and Kafka implementations and local performance runs.
- [Image credits](coupon-web/public/photo-credits.html).
