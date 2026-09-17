# MaldivesLiveaboardBooking — Maldives Yacht Marketplace MVP

MaldivesLiveaboardBooking is a working multi-vendor marketplace prototype for Maldives yacht travel. The customer experience is yacht-first rather than atoll-first: guests search by dates, guest count, private/shared travel and experience, then compare vessels and request a booking.

## Included

### Guest marketplace
- Premium Maldives/yacht visual design
- Yacht-first search and filtering
- Private charter and shared cruise inventory in one catalogue
- Experience-led discovery (luxury, diving, honeymoon, wellness, etc.)
- Verified yacht badges
- Yacht details with photo gallery, specifications, amenities and experiences
- Shared departure inventory
- Private/shared booking request flow
- Sample review/rating and pricing presentation

### Vendor/operator portal
- Fleet overview
- Create and edit yacht listings
- Manage primary and gallery image URLs
- Manage descriptions, capacities, rates, amenities and experiences
- Enable private charter and/or shared cruise modes
- Publish scheduled shared departures
- Review and confirm/decline booking requests

### Admin portal
- Marketplace statistics
- Yacht verification queue
- Verified badge controls
- Recent booking activity

### Backend
- Python standard-library HTTP server
- SQLite data persistence
- JSON API endpoints for yachts, departures, bookings, enquiries and admin controls
- Seeded demonstration vendor and yacht inventory

## Run locally

```bash
cd maldives-yacht-platform
python3 app.py
```

Then open:

- Marketplace: http://localhost:8000/
- Vendor portal: http://localhost:8000/vendor.html
- Admin portal: http://localhost:8000/admin.html

## Cloudflare staging

The Cloudflare-native staging deployment is available at:

- https://maldivesliveaboardbooking.com

The apex domain is canonical and `www.maldivesliveaboardbooking.com` permanently redirects to it. The Worker continues to be available at `https://atolle-staging.aaishathhanaa.workers.dev` as an operational fallback. It serves the frontend through Workers Static Assets and runs the API in a TypeScript Worker backed by the `atolle-staging` D1 database. Authentication is enforced, the documented demo accounts are enabled, and BML remains in mock/sandbox mode. The demo accounts are staging-only and must not be enabled in production.

To validate and redeploy:

```bash
npm install
npx wrangler types --env staging
npx tsc
npx wrangler d1 migrations apply DB --env staging --remote
npx wrangler d1 execute DB --env staging --remote --file cloudflare/staging/enable-demo-users.sql
npm run deploy:staging
npm run test:staging:performance
```

Enable D1 read replication for `atolle-staging` in **Cloudflare Dashboard → D1 → atolle-staging → Settings**. Anonymous search reads use `DB.withSession("first-unconstrained")`; authenticated requests and writes continue to use the primary binding.

### Automatic staging deployment

GitHub Actions runs the complete verification suite for every pull request to `main`. A successful push or merge to `main` then applies pending D1 migrations, deploys the Worker, and runs non-destructive checks against staging. The workflow can also be dispatched manually from `main`.

Configure a GitHub Environment named `staging` with these environment secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` — scoped only to this account's Workers deployment and D1 migration access
- `STAGING_TEST_EMAIL`
- `STAGING_TEST_PASSWORD`

The staging test identity should be a dedicated active vendor or administrator account. Do not reuse production credentials. The environment must not require reviewer approval if deployments are expected to remain automatic.

Protect `main` by requiring a pull request and the `verify` status check, requiring branches to be up to date, and blocking force pushes and deletion. Reviewer approval is intentionally not required so a solo maintainer can merge after CI passes.

Run the same local verification suite with:

```bash
npm ci
npm run ci
```

Remote database migrations run before the new Worker version. Keep migrations backward-compatible with the currently deployed code. A failed migration or deployment must be repaired with a forward migration/deployment; do not automate database rollback.

Do not promote this staging environment to live payments until the remaining items in `PRODUCTION-READINESS.md` are complete.

## Production work still required

This package is a functional product MVP, not a production deployment. A commercial launch should replace demo access with secure authentication/authorization, use an object-storage service for direct photo uploads, add payments and commission settlement, transactional email/WhatsApp notifications, real availability locking, cancellation/refund workflows, operator KYC/document verification, rate limiting, audit logs, database migrations and production hosting.

## Demo media and listing data

The interface references free-to-use Pexels photography for demonstration. It also includes a dated mock-data snapshot of public Maldives listings and April 2028 departure information from [LiveAboard.com](https://www.liveaboard.com/diving/search/maldives/april/2028). Imported vessel imagery remains hosted by its source. The original MaldivesLiveaboardBooking vessel records remain fictional sample content; imported prices and availability are illustrative snapshots and must not be treated as live inventory.

## BML Connect payment integration

The MVP now includes a BML Connect payment provider layer and payment records linked to bookings.

### Demo / mock mode

Mock mode is the default and requires no credentials:

```bash
python3 app.py
```

Create a booking from a yacht page, click **Continue to BML payment**, then use the payment return page to simulate a successful or cancelled BML transaction.

### BML sandbox / production

The implementation follows Bank of Maldives' official BML Connect transaction flow: server-side transaction creation, BML-hosted checkout, and redirect back to the platform. Never expose the BML API key in browser JavaScript.

Set environment variables before starting the server:

```bash
export BML_MODE=live
export BML_ENV=sandbox          # sandbox or production
export BML_API_KEY='your-bml-api-key'
export BML_APP_ID='your-app-id'
export BML_CURRENCY=USD
export BML_RETURN_URL='https://your-domain.example/payment-return.html'
python3 app.py
```

Default API bases used by the adapter:

- Sandbox: `https://api.uat.merchants.bankofmaldives.com.mv/public/`
- Production: `https://api.merchants.bankofmaldives.com.mv/public/`
- Transaction creation: `POST /transactions`

The transaction signature is generated server-side from the amount in minor currency units, currency code and API key, following BML's official PHP SDK sample.

### Before production launch

The current project demonstrates redirect checkout and payment persistence. Before accepting real customer money, add/verify the current BML webhook or transaction-status reconciliation flow from your merchant documentation, HTTPS, authentication/authorization, idempotency, immutable order totals, refund/cancellation handling, audit logs, and production secrets management.

## Marketplace commission

- Default platform commission: **30%** of each customer payment.
- The rate is editable from **Admin → Commission** without changing code.
- Every payment snapshots `commission_rate`, `commission_amount`, and `operator_net_amount` at creation time.
- Changing the global commission only affects new payments; historical transactions keep their original commercial terms.
- Operator payouts are tracked separately with `payout_status` so settlement can be implemented independently of BML card collection.

## Recommended production architecture

The current package is appropriate for local development and staging, but the Python + local SQLite setup should not be deployed unchanged for commercial use.

For production, the recommended target is a Cloudflare-native architecture:

- **Cloudflare Workers** — application API and server-side business logic
- **Cloudflare D1** — yachts, vendors, bookings, payments, commissions and payout ledger
- **Cloudflare R2** — yacht photos, galleries and other operator-uploaded media
- **Cloudflare static hosting / Workers assets** — marketplace frontend
- **Cloudflare Secrets** — BML API credentials and other production secrets
- **BML Connect** — customer payment collection
- **Transactional email provider** — confirmations, booking updates and operator notifications

The existing SQLite schema is intentionally simple so it can be migrated to D1. Yacht media should move away from external image URLs and be uploaded to R2 through authenticated vendor workflows.

### Recommended deployment sequence

1. Create a **staging** Cloudflare environment first.
2. Migrate the local SQLite schema and seed data to **Cloudflare D1**.
3. Move yacht/gallery media to **Cloudflare R2**.
4. Replace demo access with secure **customer, vendor and admin authentication**.
5. Complete and test the **BML sandbox** payment flow, including authoritative transaction-status/webhook reconciliation.
6. Keep the default **30% marketplace commission** configurable in Admin and preserve a commission snapshot on every payment.
7. Implement the **operator wallet / settlement ledger** and payout workflow.
8. Add transactional booking/payment notifications.
9. Add database-backed **availability locking** to prevent double bookings.
10. Complete operator **KYC and yacht/document verification** workflows.
11. Add refunds, cancellations, audit logs, rate limiting, monitoring and backup/recovery procedures.
12. Complete security testing, connect the production domain and only then switch BML from sandbox to production.

### Production status

The product should currently be treated as **staging-ready, not live-payment production-ready**. Do not accept real customer payments until all launch-blocking items in `PRODUCTION-READINESS.md` are complete and the BML production flow has been verified against the merchant documentation issued for the live account.

See **[PRODUCTION-READINESS.md](PRODUCTION-READINESS.md)** for the detailed launch checklist and target infrastructure.

## Production-oriented systems now implemented

The backend has been expanded beyond the original MVP. The current codebase now includes:

- PBKDF2 password hashing, HttpOnly/Secure/SameSite session cookies, session expiry and role-aware access controls
- optional `ENFORCE_AUTH=1` production mode while preserving local demo mode
- vendor ownership checks and separate admin/vendor/customer roles
- operator/KYC document metadata and admin review states
- server-side booking price calculation (the browser no longer controls the payable amount)
- transaction-protected private-yacht and shared-departure inventory holds
- capability tokens and idempotency keys for guest bookings and payments
- configurable booking deposit percentage and remaining-balance accounting
- payment types: deposit, balance and full payment
- BML transaction creation plus authoritative transaction lookup/reconciliation hook
- configurable 30% default commission with immutable payment snapshots
- commission/operator-net accounting per payment
- refund adjustment ledger with proportional commission/operator reversals
- operator available-balance calculation and payout records
- admin payout creation and paid-status workflow
- in-app booking lifecycle notifications
- immutable-style audit trail for privileged and financial actions
- CSP/HSTS security headers, bounded request bodies, login throttling and no-store API responses
- automated smoke test covering login, booking, deposit, mock BML payment, 30% commission and operator ledger
- Cloudflare D1 migration starter and `wrangler.toml.example`

Run the smoke test with:

```bash
python3 tests/smoke.py
```

The Worker integration suite creates isolated temporary D1 storage, applies all migrations, loads `tests/worker-fixture.sql`, starts Wrangler on an available local port, and cleans up automatically:

```bash
npm run test:worker
```

### Demo credentials

When `ENFORCE_AUTH=1` is enabled locally:

- Admin: `admin@atolle.mv` / `AtolleAdmin123!`
- Vendor: `operator@example.com` / `AtolleVendor123!`
- Guest: `guest@example.com` / `AtolleGuest123!`

Change/remove these seeded credentials before any public deployment.

## External launch dependencies that code cannot complete by itself

The application logic is substantially implemented, but a public real-money launch still depends on external credentials/services and operational decisions. These are not safe to fake in source code:

- BML merchant approval, live API credentials and confirmation of the merchant account's current refund/callback procedures
- deployment of the API to the chosen production runtime (the repository includes a D1 schema/wrangler starter; the current working server remains Python)
- Cloudflare R2 bucket creation and direct-upload credentials/bindings for yacht media
- a transactional email provider and verified sending domain
- actual operator KYC documents and business review process
- legal marketplace terms, privacy/cancellation policies and vendor agreements
- production domain/DNS, monitoring and incident-response ownership

Until those external items are connected and verified, use BML mock/sandbox mode rather than accepting live customer funds.
# maldives-yacht
# Guest marketplace and homepage APIs

The homepage reads verified public content from `GET /api/homepage`. Guest accounts use
`/api/account/dashboard`, `/api/account/wishlist`, `/api/account/bookings/claim`, and
`/api/account/reviews`. Anonymous booking claims require both the booking reference and
the original booking access token; email is never accepted as proof of ownership.

Support requests are submitted through `POST /api/support`. Administrators moderate
reviews and support requests and manage consultant profiles and verified trust marks in
`admin-content.html`. Apply Cloudflare migration `0009_guest_marketplace_homepage.sql`
before deploying the matching Worker.
