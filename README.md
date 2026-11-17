# Paw & Pantry

Paw & Pantry is a full-stack kitchenware store built with React, TypeScript, Spring Boot, and PostgreSQL. Shoppers can browse products, select which cart items to buy, apply a coupon at checkout, and view their order history. Payment, refunds, and shipping are simulated.

## Architecture

```text
React storefront ── Nginx ── Spring Boot API ── PostgreSQL
                              │
                              └── Keycloak (OpenID Connect)
```

| Directory | Contents |
| --- | --- |
| [app](app) | Java 21 API, coupon eligibility and redemption, checkout transactions, and order history |
| [coupon-web](coupon-web) | React storefront and component tests |
| [coupon-client](coupon-client) | Typed client for coupon operations |
| [e2e](e2e) | Playwright acceptance tests |
| [deploy](deploy) | Docker Compose, local identity fixture, and database migrations |

The storefront uses PostgreSQL for claims. The [coupon claim experiments](docs/claim-experiments.md) use a separate Docker stack to compare claim implementations with Redis, Kafka, and k6.

## Run locally

Install Docker with Compose v2. Run the following from the repository root in PowerShell.

```powershell
$compose = @('--project-directory', '.', '-p', 'coupon-demo', '--env-file', 'deploy/rehearsal.env',
  '-f', 'deploy/docker-compose.release.yml', '-f', 'deploy/docker-compose.rehearsal.yml')
docker compose @compose up -d --build postgres keycloak migrate app web
Get-Content -Raw deploy/retail-offers.sql |
  docker compose @compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U coupon -d coupon
```

Open [localhost:5186](http://localhost:5186) and sign in with a [local demo account](deploy/keycloak/coupons-realm.json). Add the $50 skillet and $25 utensil set, claim **Kitchen starter savings**, and apply it at checkout. The $10 discount brings the total to $65. The receipt appears under **My orders**.

Stop the stack with `docker compose @compose stop`. For release verification commands, see the [release guide](deploy/README.md).

## Checkout behavior

- **Retry after a lost response.** The browser reuses the order ID and original cart contents after a refresh in the same tab. The API returns the existing receipt without deducting inventory again.
- **Insufficient inventory.** If one selected item cannot be reserved, PostgreSQL rolls back the order and any earlier stock deductions. The coupon remains available.
- **Refund and shipment.** Both operations lock the same order row. If they race, only one succeeds. A refund restores the stock once.

## Tests

[Coupon CI](.github/workflows/coupon.yml) runs Java and TypeScript tests, checkout API checks against Docker services, and a Chromium release rehearsal. The Java job uploads a JaCoCo report.

- Run Java unit and controller tests with `mvn -f app/pom.xml test`. For the [PostgreSQL checkout cases](app/src/test/java/com/coursework/coupon/CheckoutPostgresTest.java), set `CHECKOUT_TEST_JDBC_URL`, `CHECKOUT_TEST_DB_USER`, and `CHECKOUT_TEST_DB_PASSWORD` to a test database whose user can create schemas.
- See [storefront development](coupon-web/README.md) for the frontend build and test commands.

[Image credits](coupon-web/public/photo-credits.html)
