# Pharmacy POS SaaS: Functionality & Modules Spec
Sep 29, 2026 · @CJ
## Overview
A subscription pharmacy POS for Pakistani medical stores: an offline-first counter app on a cloud platform, sold, onboarded and supported directly by our team.

| App | Stack | Used by | Job |
| Desktop POS | Tauri + React, local SQLite | Cashiers | Billing, stock receiving, inventory; works fully offline |
| Backend | Next.js API + background worker | All apps | Sync, catalogue, FBR, billing, reports |
| Owner web panel | React | Pharmacy owners | Multi-branch control, reports, purchases, billing |
| Owner mobile app | React Native | Pharmacy owners | Live sales, alerts, approvals |
| Super-admin panel | React | Your team | Tenants, catalogue curation, collections, revenue |

system architecture · 4 apps, 1 backend, 4 outside services
No app talks to FBR, payment providers or DRAP directly; the desktop POS keeps billing offline and syncs through the backend when connected.
Phase tags: [MVP] first release · [v2] next release · [Later] after that.
MVP cut: desktop billing; stock receiving with 2D scan and batch-level pricing; master catalogue with price updates; Excel/Abuzar import wizard; credit ledger; offline sync; FBR; subscriptions with grace mode; owner dashboard and mobile alerts.
## 1. Desktop POS (Tauri + React)
The counter app cashiers use all day; it runs fully offline on local SQLite and syncs when online.
### Billing / POS
- [MVP] Keyboard-first billing with F-key shortcuts, familiar to Abuzar users
- [MVP] Search by brand, generic/salt, company or barcode; generic substitutes when out of stock
- [MVP] Sell in packs, strips or single tablets with automatic unit conversion
- [MVP] Item and bill discounts; block selling above the official retail price
- [MVP] Hold/resume bills, sale returns and exchanges
- [MVP] Payment by cash, card or credit (udhaar)
- [v2] JazzCash, Easypaisa and Raast QR payments
- [MVP] Thermal receipt printing (58/80mm)
- [v2] WhatsApp/SMS receipts
- [MVP] FBR invoice number and QR code for Tier-1 shops
- [MVP] Shift open/close, cash drawer, end-of-day closing report
### Stock receiving
- [MVP] Purchase invoice entry by supplier, with bonus/free quantity and trade discount
- [MVP] Scan the DRAP 2D code to fill product, batch, expiry and serial automatically
- [MVP] Retail price stored per batch, so old and new stock sell at different prices
- [MVP] Price-change detection: flag items arriving at a price different from the master list, and report it to the server
- [v2] Flag duplicate or suspicious serial numbers as possible counterfeits
### Inventory
- [MVP] Batch and expiry tracking; sell earliest-expiring stock first
- [MVP] Low-stock and near-expiry alerts
- [MVP] Stock adjustments, physical counts, write-offs for damaged or expired items
- [MVP] Rack/shelf location per item
- [v2] Returns to distributors, including near-expiry claims
- [v2] Stock transfers between branches
### Medicine master
- [MVP] Preloaded list of DRAP-registered medicines, synced from the server
- [MVP] Automatic master price updates, with local override
- [MVP] Shop-specific items: cosmetics, surgical, baby and general products
- [MVP] Flags for prescription-only and controlled/scheduled drugs
### Migration and onboarding
- [MVP] Import wizard: upload Excel, map columns, preview
- [MVP] Fuzzy matching of old item names to the master list, with a review screen
- [MVP] Opening balances: stock with batch and expiry, customer credit, supplier balances
- [MVP] Assisted setup mode for our onboarding team during the installation visit
- [v2] One-click Abuzar import via a converter that reads its database (with the owner's permission)
### Prescriptions and controlled drugs
- [MVP] Patient and doctor details for scheduled drugs, kept as a narcotics register
- [Later] Attach a prescription photo
### Customers
- [MVP] Customer profiles, credit ledger (khata) and credit limits
- [v2] Refill reminders and loyalty points
### Subscription behaviour
- [MVP] Billing never stops; a lapsed subscription enters grace mode, pausing reports, cloud sync, the mobile app and FBR sync
- [MVP] On-screen renewal reminders and a renew/pay screen
- [MVP] Owners can always export their own data, even after a lapse
### System
- [MVP] Offline-first sync queue with conflict handling and retries
- [MVP] PIN login per user, role permissions, audit log of voids and discounts
- [MVP] Hardware: barcode scanner, 2D imager, thermal printer, cash drawer
- [MVP] Urdu and English interface
- [MVP] Automatic updates through the Tauri updater
## 2. Backend (Next.js + worker)
Next.js serves the APIs; long-running work (sync processing, FBR retries, billing runs, price pushes) goes to a separate worker, for example BullMQ with Redis.
- [MVP] Auth and multi-tenancy: organisation → branches → devices → users; roles for owner, cashier and super-admin
- [MVP] Sync API: push/pull changes, retry-safe without duplicates, conflict rules, device registration
- [MVP] Master catalogue service: seed from DRAP registered-products data; version every price change with date and source (SRO, company price list, distributor invoice, shop report); push updates to all shops
- [MVP] Price intelligence: collect shop price-change reports, group by product, queue for verification before publishing
- [MVP] Subscription and billing engine: plans, trials, monthly/quarterly/yearly billing with prepay discounts, invoices, grace periods, features by plan, manually recorded cash payments
- [MVP] Payments for subscriptions: JazzCash, Easypaisa, Raast
- [v2] Payments for shop sales: same providers at the counter
- [MVP] Migration service: Excel templates, Abuzar converters, item-name matching against the master list
- [MVP] FBR integration: post invoices via a licensed integrator or PRAL, retry queue, status tracking
- [MVP] GS1 barcode parsing of the DRAP 2D code
- [Later] Verify serials against DRAP once its system is live
- [MVP] Reporting engine: sales, profit and stock aggregates
- [MVP] Data export: full export of a shop's data on request
- [v2] Notifications: WhatsApp Business API, SMS, mobile push
- [MVP] Backups, audit logs and monitoring
## 3. Owner web panel (React)
The owner's control room across all branches.
- [MVP] Dashboard: today's sales, profit, cash in hand, top-selling items, per branch
- [MVP] Inventory: stock across branches, expiry report, dead stock, reorder suggestions
- [MVP] Price updates: see changed master prices; approve or override for the shop
- [MVP] Purchases and suppliers: purchase orders, supplier ledger, payables
- [v2] Ordering directly from distributors
- [MVP] Customers: receivables, credit ledgers, overdue customers
- [MVP] Staff: users, roles, shift history; theft alerts for voids, big discounts and deleted bills
- [MVP] Basic accounting: expenses, cash book, simple profit and loss
- [MVP] Reports: sales, margin by pharma company, tax, controlled drugs register
- [MVP] Subscription and billing: current plan, invoices, pay online, payment history
- [MVP] Data export at any time; import/migration status
- [MVP] Settings: FBR credentials, invoice template, pricing rules, printers
- [Later] E-commerce and delivery orders from the same catalogue
## 4. Owner mobile app (React Native)
Kept small: for checking in, not running the shop.
- [MVP] Live sales and cash summary by branch
- [MVP] Push alerts: voids, large discounts, low stock, near-expiry, day-close summary
- [MVP] Stock and price lookup
- [MVP] Subscription status, renewal reminders, in-app payment
- [v2] Remote approval of discounts, returns and credit above a set limit
- [v2] Scan a box to check stock, price or authenticity
- [v2] Supplier payables and customer credit overview
## 5. Super-admin panel (your company)
Runs the business: tenants, catalogue, collections and revenue.
- [MVP] Tenant management and onboarding: create shop accounts, activate devices, run migration
- [MVP] Plans, pricing, trials, features by plan
- [MVP] Device activation and deactivation
- [MVP] Catalogue curation: review queue for shop-reported price changes, SRO and price-list uploads, merging duplicate products, pushing updates to all shops
- [MVP] Collections dashboard: revenue, overdue shops, shops in grace mode, churn; record cash payments with receipts sent to the shop
- [MVP] Support tools: view a shop's data, logs and sync status
- [MVP] FBR integration health across all tenants
- [v2] Migration tools: Abuzar converters and item-name matching rules
- [v2] Feature flags and update channels (stable/beta)
- [v2] Usage analytics across the platform
- [v2] Support tickets
- [v2] Leads and demo tracking