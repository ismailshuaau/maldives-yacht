# MaldivesLiveaboardBooking Production Readiness

## Current code status

**Production-oriented application code / staging-ready.** The core marketplace, booking, financial and control-plane logic is implemented. A live commercial launch still requires external merchant, hosting, storage, messaging, legal and operator-verification inputs.

### Implemented in code

- [x] Yacht-first marketplace and yacht detail experience
- [x] Vendor-managed yacht listings and shared departures
- [x] Admin yacht verification
- [x] Customer/vendor/admin roles
- [x] Password hashing, bearer sessions and session expiry
- [x] Guest registration
- [x] Vendor ownership authorization checks
- [x] Operator/KYC document metadata and admin review workflow
- [x] Server-side booking amount calculation
- [x] Private yacht date-conflict checks
- [x] Temporary availability holds and expiry
- [x] Shared departure inventory holds
- [x] Configurable deposit percentage and balance accounting
- [x] Deposit/balance/full payment types
- [x] BML-compatible server-side transaction creation
- [x] BML transaction lookup/reconciliation endpoint
- [x] Configurable default commission (30%)
- [x] Payment-level commission snapshots
- [x] Operator net amount ledger
- [x] Refund adjustment records and proportional commission reversal
- [x] Operator available-balance calculation
- [x] Payout creation and paid-status workflow
- [x] Notification queue
- [x] Audit log
- [x] Basic API rate limiting and security headers
- [x] Automated smoke test
- [x] D1 SQL migration starter and Cloudflare wrangler example

## External/production integration still required

These cannot be truthfully completed without real accounts, policies or infrastructure:

- [ ] BML production merchant account and live API credentials
- [ ] Confirm BML's current live callback/refund requirements against merchant-issued documentation
- [ ] Execute real BML sandbox reconciliation tests with merchant credentials
- [ ] Create Cloudflare D1 production/staging databases and apply migrations
- [ ] Create R2 media bucket and replace URL-only demo media with authenticated upload flow
- [ ] Select and configure transactional email provider
- [ ] Replace demo user credentials and configure production secret management
- [ ] Configure production DNS/TLS/domain
- [ ] Configure observability/error alerting and backup/recovery runbook
- [ ] Collect and approve real vendor/operator KYC and vessel documentation
- [ ] Publish reviewed marketplace terms, privacy policy, cancellation/refund policy and vendor agreement

## Recommended Cloudflare target

- Cloudflare Workers: API/business logic
- Cloudflare D1: transactional marketplace data
- Cloudflare R2: yacht/gallery/document media
- Cloudflare Secrets: merchant/session/email secrets
- Static assets through Workers/Cloudflare hosting

The repository contains `cloudflare/migrations/0001_initial.sql` and `cloudflare/wrangler.toml.example` as migration/deployment starters. The currently tested backend is `app.py`; do not claim the Python server itself is already a deployed Worker.

## Payment/commission model

Default commission is **30%**, adjustable in Admin. Each payment snapshots its rate, commission amount and operator net, so changing the global rate only affects future payments.

Example: customer payment USD 10,000 → commission USD 3,000 → operator net USD 7,000.

Refund records proportionally reverse both platform commission and operator payable. Payouts are separate records and should only be marked paid after actual settlement to the operator.

## Pre-launch acceptance test

Before switching BML to production:

1. Enable `ENFORCE_AUTH=1`.
2. Replace demo credentials.
3. Run `python3 tests/smoke.py`.
4. Test real BML sandbox create → redirect → transaction reconciliation.
5. Test concurrent bookings for the same private-yacht dates and confirm one is rejected.
6. Test shared inventory exhaustion.
7. Test deposit followed by balance payment.
8. Test partial/full refund accounting.
9. Test vendor cannot update another vendor's yacht.
10. Test admin-only settings, KYC, refunds and payouts.
11. Verify audit records are created for financial/admin actions.
12. Verify operator available balance reflects payments, refunds and payouts.
13. Verify media upload controls after R2 is connected.
14. Verify email notifications after the provider is connected.
15. Complete security/legal review before accepting live funds.
