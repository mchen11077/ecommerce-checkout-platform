# QA report

Verified on November 17, 2026 against the current storefront and backend. All checks below passed locally. This report describes executed tests; it does not claim exhaustive coverage or production readiness.

## Results

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Java unit, MockMvc API, and PostgreSQL integration tests | 38 | 0 | 0 |
| TypeScript client unit tests | 16 | 0 | 0 |
| Storefront component tests | 23 | 0 | 0 |
| Redis/Kafka checkout integration acceptance checks | 5 | 0 | 0 |
| Chromium browser tests | 27 | 0 | 0 |
| WebKit browser tests | 27 | 0 | 0 |

The 136 checks above include 27 browser scenarios executed in each engine. Migration, backup restore, and outage recovery checks also passed separately.

## Behaviors verified

- Product search, category filters, both price sort directions, image loading, and product details with dimensions, materials, care instructions, and add-to-cart. Product dialog keyboard controls and cart selection, quantities, removal confirmation and cancellation also pass.
- Two-account coupon ownership, duplicate claims, a concurrent final-stock claim, rate limiting, minimum spend, and quote retry.
- Guest and authenticated checkout, server-side prices, CSRF enforcement, invalid quantities, insufficient inventory, and idempotent retries.
- A completed checkout whose response never reaches the browser: refreshing and retrying returns the original receipt without deducting stock twice. The authenticated case also preserves the original coupon after redemption. A request interrupted before reaching the server can be retried too.
- Concurrent stock reservations do not oversell. A failure after an earlier inventory deduction rolls back the order. Injected database failure rolls back both order creation and coupon redemption.
- Simulated payment, refund, shipment, order history, repeated refund, shipment/refund conflicts, and ownership enforcement. A lost response after a committed refund or shipment can be retried without repeating the stock change. Expanded receipts stay open during background refresh.
- Twenty-six PostgreSQL orders verify pagination, equal-timestamp ordering, account isolation, and status filtering. A component scenario checks navigation through twenty-five orders and resetting the page when the status changes. Browser tests exercise the server-backed status controls.
- Session expiry during checkout preserves the cart and pending request. A stale CSRF token is refreshed once and the identical order request is retried. Initial session loading can be retried from the page.
- A selected coupon expiring while the checkout is open loses its displayed discount and blocks submission. A PostgreSQL test expires a coupon after a valid quote and verifies that confirmation creates no order, changes no stock, and consumes no coupon use.
- Chromium and WebKit layouts at 320, 390, 480, 600, 768, 820, 1024, and 1440 px. Filtering does not expand a lone product card; catalog images stay within 220 px height. Cart controls, dialogs, and horizontal overflow checks pass. Order history is checked at seven widths.
- Legacy migration preserves existing data and can run twice; backup restoration matches coupon, claim, and order rows. Stopping the backend triggers the outage alert, which clears after recovery.

## Coverage

Fresh JaCoCo and Vitest V8 reports were generated for this run. Browser and standalone API acceptance traffic is not included in these unit-test coverage numbers.

| Source scope | Line coverage | Branch coverage |
| --- | ---: | ---: |
| Java application | 264 / 594 (44.44%) | 112 / 272 (41.18%) |
| TypeScript client | 59 / 61 (96.72%) | 27 / 35 (77.14%) |
| React storefront | 414 / 500 (82.80%) | 452 / 598 (75.58%) |

The Java checkout class reaches 133 / 145 lines (91.72%) and 75 / 99 branches (75.76%). Application-wide Java branch coverage remains modest. Entry-point bootstrap and some failure branches remain uncovered by component tests. V8 instrumentation was upgraded with Vitest; older percentages are not directly comparable.

## Reproduction

Install dependencies and browsers, then run the isolated release rehearsal from the repository root:

```powershell
pnpm --dir tests/e2e install --frozen-lockfile
pnpm --dir tests/e2e exec playwright install chromium webkit
./tests/verify-release.ps1
```

The script creates a uniquely named Compose project, resets its own fixtures between browser suites, and removes that project's volumes when finished. Its default ports are 5186, 8186, and 9196; keep those available. This local run used a disposable copy with only those ports changed to 5686, 8686, and 9696 to preserve the existing preview.

The [CI workflow](../.github/workflows/coupon.yml) runs the Java tests with a real PostgreSQL service and publishes JaCoCo HTML, builds and tests both frontend packages, runs Redis/Kafka acceptance, and runs the two-engine release rehearsal. Local frontend coverage HTML and raw execution logs are retained outside version control. This report records local execution, not a claim that a new remote CI run has completed.

## Remaining gaps

See the [feature matrix](FEATURE_MATRIX.md) for per-feature scope. Priorities for another pass are:

1. Additional reusable-coupon combinations across multiple completed orders.
2. Sign-out network failure and recovery from a long-lived offline session.
3. Orders inserted by another client while the customer is already paging through history.
4. Additional Java branch and component tests, especially startup/authentication and order action errors.
5. Physical iOS, Android, and tablet checks; screen-reader and full contrast review; Firefox and Edge runs.

Responsive browser viewports are emulation, not physical-device testing. Real money, payment webhooks, delivery-provider integrations, AWS, and Azure deployment are outside this run. Payment and shipping remain simulations.
