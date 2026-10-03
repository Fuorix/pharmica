# Pharmica MVP Development Plan

## 1. Product Goal

Build Pharmica as an offline-first pharmacy POS SaaS for Pakistani medical stores.

The MVP must let a pharmacy:

- Set up an organisation, branches, devices, and staff.
- Search and sell medicines from a local POS while offline.
- Receive stock with batches, expiry dates, prices, and DRAP 2D barcode data.
- Track inventory, customers, credit, suppliers, and controlled-drug records.
- Synchronise safe changes with the cloud backend when connectivity returns.
- Give owners operational dashboards, reports, alerts, exports, and subscription controls.
- Give the Pharmica team tenant, catalogue, subscription, collection, and support tools.
- Submit FBR invoices through the backend when the shop is configured for FBR.

The MVP is complete when a pilot pharmacy can operate its daily counter workflow offline and an owner and Pharmica operator can manage the shop from the connected panels.

## 2. Repository Boundaries

### Main monorepo

- `apps/api`: Next.js API and backend application services.
- `apps/pos`: React POS UI wrapped by Tauri, with local SQLite.
- `apps/owner-web`: owner dashboard for one or more branches.
- `apps/admin-web`: internal Pharmica super-admin panel.
- `packages/contracts`: shared request, response, and domain types.
- `packages/api-client`: typed client used by all remote clients.
- `packages/database`: Prisma schema, migrations, and database access.

### Separate mobile repository

The owner mobile app lives in a separate repository. It consumes the same backend API and versioned contracts. Mobile development starts after the API contracts, authentication, and alert events are stable.

## 3. Architecture Rules

- The backend is the only service that talks to FBR, payment providers, DRAP-related services, and notification providers.
- The POS must continue billing when the network is unavailable.
- Every cloud mutation must be idempotent and safe to retry.
- Organisation and branch scope must be enforced on the server, never only in the UI.
- The POS keeps an append-only local sync queue and records the source device for every mutation.
- Batch stock is the source of truth for expiry and retail price decisions.
- Sensitive secrets remain server-side. Browser and desktop variables use only public `VITE_` configuration.
- API contracts are shared through `packages/contracts`; mobile must not import backend source files directly.
- All destructive, financial, discount, void, return, and permission actions must be auditable.
- Features are delivered as vertical slices that include API, database, UI, offline behavior where relevant, and tests.

## 4. MVP Milestones

### M0 - Project foundation

**Outcome:** Every developer can install, run, typecheck, and build the monorepo.

Deliverables:

- pnpm workspace and Turborepo task pipeline.
- API, POS, owner, and admin application shells.
- Tauri POS shell configuration.
- Shared contracts, API client, database package, and Prisma schema.
- Environment examples and secret-handling rules.
- Local PostgreSQL and Redis development setup.
- CI checks for install, typecheck, lint, test, and build.
- Baseline logging, error format, and API versioning convention.

Exit criteria:

- A clean checkout passes `pnpm install`, `pnpm typecheck`, and `pnpm build`.
- Each application starts on its documented local port.
- No secrets are committed.

### M1 - Identity and tenancy

**Outcome:** A user can securely sign in and access only the organisation and branch data allowed by their role.

Deliverables:

- Organisation, branch, device, user, role, and session models.
- Roles: owner, cashier, and super-admin.
- PIN login for the POS and secure web login for panels.
- Password or PIN hashing, session expiry, refresh/revocation, and logout.
- Server-side organisation and branch authorization middleware.
- Device registration and activation/deactivation.
- User management for owners and super-admins.
- Audit events for login, logout, failed login, role changes, and device changes.
- Login and session screens for POS, owner web, and admin web.

Exit criteria:

- A cashier cannot access another branch or organisation.
- An owner cannot access another tenant.
- A deactivated device cannot create new sales.
- Session and authorization tests cover every protected route.

### M2 - Catalogue and database foundation

**Outcome:** The system has a stable product and inventory model shared by the POS and panels.

Deliverables:

- Product master with brand, generic/salt, company, barcode, units, retail price, and flags.
- Pack, strip, and tablet unit conversion rules.
- Prescription-only and controlled/scheduled medicine flags.
- Branch-specific shop items for cosmetics, surgical, baby, and general products.
- Batch model with batch number, expiry, quantity, cost, retail price, and location.
- Earliest-expiry-first stock selection rules.
- Master price history with effective date and source.
- Catalogue search by name, generic, company, and barcode.
- Seed/import mechanism for DRAP-registered medicine data.
- Server validation schemas and database constraints.

Exit criteria:

- The same product can have different batches and retail prices.
- Search returns results by brand, generic, company, and barcode.
- Selling logic can select the correct batch by expiry and availability.
- Price history is retained rather than overwritten.

### M3 - Offline POS billing

**Outcome:** A cashier can complete a normal sale without network access.

Deliverables:

- Local SQLite database for catalogue, batches, customers, shifts, bills, and sync queue.
- Keyboard-first billing screen with F-key shortcuts.
- Product search and barcode input.
- Generic substitute suggestions when the requested product is unavailable.
- Pack, strip, and tablet quantity entry with automatic conversion.
- Item and bill discounts with permission limits.
- Retail-price ceiling enforcement.
- Cash, card, and credit payment methods.
- Hold, resume, void, sale return, and exchange workflows.
- Thermal receipt layout for 58mm and 80mm printers.
- Shift open, shift close, cash drawer, and end-of-day report.
- Local audit records for discounts, voids, returns, and deleted lines.

Exit criteria:

- A complete sale can be created, printed, voided, and returned offline.
- The POS prevents invalid quantities, negative stock, unauthorized discounts, and above-retail pricing.
- Restarting the POS does not lose completed local bills.
- Keyboard operation covers the primary cashier workflow.

### M4 - Stock receiving and inventory control

**Outcome:** A shop can receive, price, count, and manage stock accurately.

Deliverables:

- Purchase invoice entry by supplier.
- Purchase lines with bonus/free quantity and trade discount.
- DRAP/GS1 2D code parser for product, batch, expiry, and serial fields.
- Manual correction flow when a scan is incomplete or incorrect.
- Batch-level retail price storage.
- Price-change detection against the master catalogue.
- Local and server price-change report queue.
- Stock adjustments, physical counts, damaged stock, expired stock, and write-offs.
- Rack/shelf location.
- Low-stock and near-expiry calculations.
- Inventory screens in POS and owner web.

Exit criteria:

- Receiving creates correct batch stock and cost calculations.
- Bonus quantity and discounts are visible in purchase totals.
- Old and new batches can sell at different retail prices.
- Stock adjustments require a reason and create audit entries.
- Near-expiry and low-stock reports agree with the inventory ledger.

### M5 - Customers, credit, suppliers, and controlled drugs

**Outcome:** The daily pharmacy ledger and regulated sale records are usable.

Deliverables:

- Customer profiles and search.
- Credit limits and customer credit ledger.
- Credit sale, repayment, adjustment, and overdue balance workflows.
- Supplier profiles, supplier balances, and purchase ledger.
- Patient and doctor details for scheduled-drug sales.
- Narcotics/controlled-drug register with immutable sale references.
- Owner views for receivables, payables, and controlled-drug reports.

Exit criteria:

- Credit sales update the customer ledger exactly once.
- Payments and adjustments are traceable to an operator and timestamp.
- Credit limits are enforced according to shop policy.
- Controlled-drug records cannot be silently edited or deleted.

### M6 - Sync and offline recovery

**Outcome:** Offline POS activity safely reaches the backend and cloud changes reach the POS.

Deliverables:

- Device registration and sync cursor.
- Push and pull sync endpoints.
- Idempotency keys for every queued mutation.
- Retry policy with exponential backoff and dead-letter state.
- Conflict rules for stock, prices, customer credit, and catalogue updates.
- Local sync status, retry, and failure screens.
- Server-side change log and per-device acknowledgement.
- Safe handling of duplicate requests and reconnect storms.
- Exportable local queue diagnostics for support.

Exit criteria:

- A sale created offline appears once in the backend after reconnect.
- Replaying the same request does not duplicate stock or credit movements.
- Conflicts have deterministic rules and are visible to operators.
- A failed sync does not block local billing.
- Device recovery can resume from the last acknowledged cursor.

### M7 - Owner web panel

**Outcome:** Owners can operate and monitor their pharmacy from the web.

Deliverables:

- Dashboard with today's sales, profit, cash in hand, top items, and branch comparison.
- Cross-branch inventory, expiry, dead-stock, and reorder views.
- Master price updates with approve/override workflow.
- Purchases, suppliers, and payables.
- Customers, receivables, credit ledgers, and overdue accounts.
- Staff, roles, shift history, and suspicious activity alerts.
- Expenses, cash book, and basic profit and loss.
- Sales, margin by company, tax, and controlled-drug reports.
- Full data export and migration status.
- FBR credentials, invoice template, pricing rules, and printer settings.
- Subscription status, invoices, payment history, and renewal screen.

Exit criteria:

- Every dashboard number can be traced to a backend query and date range.
- Branch filters enforce the owner's permitted scope.
- Reports handle empty, offline, and partially synced states clearly.
- Owners can export their data without support intervention.

### M8 - Super-admin panel

**Outcome:** Pharmica staff can onboard and support tenants without direct database work.

Deliverables:

- Tenant creation and onboarding workflow.
- Organisation, branch, device, and user activation.
- Migration status and onboarding checklist.
- Plans, trials, features, invoices, and subscription state.
- Catalogue curation queue for shop-reported price changes.
- Price-list and SRO source uploads with review status.
- Duplicate product merge workflow with audit trail.
- Collections dashboard, overdue shops, grace-mode shops, churn, and cash payment recording.
- Support view for shop data, sync status, device logs, and audit history.
- FBR health overview across tenants.

Exit criteria:

- A new tenant can be created and activated end-to-end.
- Super-admin actions are isolated from tenant user roles.
- Catalogue changes require review before publication.
- Support staff can diagnose sync and device problems without production database access.

### M9 - Subscriptions and grace mode

**Outcome:** Subscription status controls cloud features without stopping local billing.

Deliverables:

- Plans, trial periods, monthly/quarterly/yearly billing, and prepay discounts.
- Subscription invoices and payment history.
- Manual cash payment recording with receipt reference.
- JazzCash, Easypaisa, and Raast subscription payment integration when credentials are available.
- Active, grace, and expired subscription states.
- Grace-mode rules: local billing and data export continue; cloud sync, reports, mobile access, and FBR sync pause according to policy.
- Renewal reminders and payment screen.
- Feature checks in backend, owner web, admin web, and POS.

Exit criteria:

- Subscription transitions are deterministic and auditable.
- A lapsed subscription cannot corrupt local POS operations.
- Export remains available in every subscription state.
- Payment callbacks are idempotent and reconciled to invoices.

### M10 - Migration and onboarding

**Outcome:** A real pharmacy can move from its existing records into Pharmica.

Deliverables:

- Excel templates for products, opening stock, customers, suppliers, and balances.
- Upload, column mapping, validation, preview, and error download.
- Fuzzy item-name matching against the master catalogue.
- Review screen for accepted, ambiguous, and rejected matches.
- Opening balances for stock, customer credit, and supplier balances.
- Assisted setup mode for an onboarding operator.
- Import audit trail and resumable import jobs.
- Initial Abuzar import path only where a safe input format is available; full database converter can follow after MVP validation.

Exit criteria:

- A pilot shop can import its opening data without direct database edits.
- Ambiguous matches require human review.
- Import failures do not partially corrupt balances.
- The import can be repeated safely with a clear idempotency policy.

### M11 - FBR and external integrations

**Outcome:** Configured Tier-1 shops can submit invoices reliably through the backend.

Deliverables:

- Integration adapter boundary for licensed provider or PRAL.
- Invoice payload mapping and validation.
- FBR invoice number and QR data on receipts.
- Retry queue and backoff for temporary failures.
- Submission status, failure reason, and operator-visible state.
- Tenant-specific credentials stored server-side.
- Health monitoring in the admin panel.
- Grace-mode behavior when FBR sync is paused.

Exit criteria:

- The POS never calls FBR directly.
- A failed submission can be retried without creating duplicate invoices.
- The operator can distinguish pending, accepted, rejected, and retryable states.
- Integration tests run against a provider sandbox or contract fixture.

FBR credentials are not required for early local development. The adapter and status model should be built behind a feature flag until sandbox access is available.

### M12 - Owner mobile MVP

**Outcome:** Owners can monitor shops from the separate mobile repository.

Deliverables:

- Shared API contract and generated/mobile-compatible client.
- Owner authentication and secure session storage.
- Live sales and cash summary by branch.
- Push alerts for voids, large discounts, low stock, near-expiry, and day close.
- Stock and price lookup.
- Subscription status, renewal reminders, and in-app payment handoff.
- Offline-friendly read cache with clear last-updated timestamps.

Exit criteria:

- Mobile access respects the same organisation and branch authorization as web.
- Alerts are deduplicated and deep-link to the relevant record.
- Mobile remains read-only for MVP except payment actions.
- API changes are versioned so mobile releases are not broken unexpectedly.

## 5. Cross-Cutting Quality Gates

Every milestone must include:

- Unit tests for domain rules and calculations.
- API integration tests for authorization, idempotency, and validation.
- Database migration tests.
- React component and workflow tests for high-risk screens.
- Offline/reconnect tests for POS features.
- Audit-log assertions for privileged and financial actions.
- Accessibility checks for keyboard and form workflows.
- Urdu and English translation key coverage before release.
- Structured logs with correlation ID, organisation ID, branch ID, device ID, and request ID where available.
- No sensitive data in logs, browser storage, receipts used for testing, or error messages.

## 6. Pilot Release Gates

Before onboarding a real pilot shop:

- Backup and restore have been tested.
- Data export has been tested for a tenant in active and grace states.
- Local POS restart and power-loss recovery have been tested.
- Duplicate sync requests and network interruption scenarios have been tested.
- Thermal printer, barcode scanner, 2D imager, and cash drawer have been tested on supported Windows hardware.
- Stock, credit, cash closing, and profit totals reconcile across POS and owner web.
- FBR sandbox or disabled-mode behavior is documented.
- Subscription grace mode is tested without blocking local billing.
- Admin support can inspect sync/device/audit status.
- Error monitoring, database backups, and migration rollback procedures are documented.
- Pilot acceptance checklist is signed off by the pharmacy operator.

## 7. Explicitly Out of MVP

Do not include these until the MVP has pilot evidence:

- JazzCash, Easypaisa, or Raast payments at the pharmacy counter.
- WhatsApp and SMS receipts.
- Counterfeit serial detection and live DRAP serial verification.
- Distributor ordering and direct purchasing.
- Branch stock transfers.
- Remote approval of discounts, returns, and high-value credit.
- Refill reminders and loyalty points.
- Prescription photo attachments.
- E-commerce and delivery orders.
- Advanced analytics, feature-flag channels, support tickets, and lead tracking.
- Full one-click Abuzar database conversion if the input format is not proven.

## 8. Recommended Build Order

1. Complete M0 and local infrastructure.
2. Build M1 authentication and tenancy before exposing business data.
3. Build M2 catalogue and batch rules.
4. Build M3 offline billing as the first end-to-end vertical slice.
5. Add M4 inventory receiving and stock controls.
6. Add M5 customer credit and controlled-drug records.
7. Add M6 sync and reconnect recovery.
8. Build M7 owner web using real backend data.
9. Build M8 admin web and onboarding operations.
10. Add M9 subscriptions and grace mode.
11. Add M10 migration with a pilot dataset.
12. Add M11 FBR behind a feature flag and sandbox adapter.
13. Stabilize hardware, localization, backups, monitoring, and pilot release gates.
14. Build M12 mobile MVP in the separate repository against the stabilized API.
