# Feature coverage

Verified locally on November 17, 2026. PASS applies to the specific cases listed.

| Feature | Status | Test evidence |
| --- | --- | --- |
| Product browsing and categories | PASS | Four-product catalog, each category, image decoding, product dialog opening and dismissal. |
| Cart selection and quantities | PASS | Partial and full selection, increment, quantity cap rejection at the API, removal confirmation and cancellation, preserving unselected items after checkout. |
| Coupon claiming and ownership | PASS | Two accounts, forbidden access to another wallet, duplicate claims, concurrent final-stock claim, rate limiting. |
| Coupon ordering and eligibility | PARTIAL | Component tests check expiry ordering and hiding inactive coupons. Browser tests check minimum amount and quote request retry. Expiry while a customer is already checking out remains untested end to end. |
| Guest checkout | PASS | Server pricing, coupon rejection, missing CSRF rejection, invalid quantity, stock shortage, replay. |
| Signed-in coupon checkout | PASS | Price from the API, coupon redemption once, account ownership, receipt in order history. |
| Lost-response recovery | PASS | Guest and signed-in checkout succeed on the server, the response is dropped, and a refresh retries the original order. The signed-in case keeps the original coupon even after redemption. Also checks a request blocked before reaching the server. |
| Transaction rollback | PASS | Later product stock shortage restores earlier stock and preserves coupon use. An injected database failure rolls back both the receipt and redemption, then the same order succeeds after removing the fault. |
| Simulated payment | PASS | Accepted checkout records PAID and the server-calculated total. |
| Refund and shipment | PASS | Browser actions and history, repeated refund, refund after shipment rejection, and database-lock tests for both concurrent-action winners. Network failure during a refund or shipment remains untested. |
| Responsive layout | PASS | Chromium and WebKit at 320, 390, 480, 600, 768, 820, 1024, and 1440 px. Product filters retain card width, images stay within 220 px height, cart actions work, and the page has no horizontal overflow. Order history checked at seven widths. |
| Accessibility | PARTIAL | Keyboard operation for product dialog and coupon picker, Escape and focus return. Screen readers, full contrast audit, and physical touch devices remain untested. |
| Migration and restore | PASS | Release script checks legacy migration, repeated migration, and backup restore against stored rows. |
| Outage monitoring | PASS | Release script stops the app, checks the alert, restarts it, and checks recovery. |
| Session lifecycle | PARTIAL | Sign-in, sign-out, CSRF and ownership checks pass. Session expiry mid-action and logout network failure remain untested. |
| Order history pagination | NOT TESTED | More than twenty stored orders and concurrent pagination ordering. |
| Real payment and delivery providers | OUT OF SCOPE | Both operations use local simulation. |
| Physical devices and other browsers | NOT TESTED | No physical iOS/Android/tablet, Firefox, or Edge execution in this run. |
