# Tests

Run commands from the repository root.

| Location | Purpose |
| --- | --- |
| `e2e/` | Playwright browser workflows and responsive checks |
| `performance/` | k6 workloads and claim performance experiments |
| `verify-checkout.ps1` | Checkout API and database rollback acceptance |
| `verify-release.ps1` | Isolated browser, migration, restore, and recovery rehearsal |

Browser rehearsal:

```powershell
pnpm --dir tests/e2e install --frozen-lockfile
pnpm --dir tests/e2e exec playwright install chromium webkit
./tests/verify-release.ps1
```

Module tests stay beside their source: `backend/src/test`, `frontend/test`, and `coupon-client/test`.
