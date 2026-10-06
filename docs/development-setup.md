# Development Setup

Docker Desktop must be running. Then run this from the repository root whenever starting or resuming local development:

```powershell
.\scripts\prepare-dev.ps1
```

The script runs these steps in order:

1. Starts local PostgreSQL (port 5433) with Docker Compose.
2. Starts the Compose Redis on port 6379, unless another Redis already listens there.
3. Applies pending Prisma migrations.
4. Seeds development data, including `owner@demo.local`.

After preparation, start the applications with:

```powershell
pnpm dev
```

The preparation script is for local development only. It does not replace production database migrations or production seed procedures.

To stop the local services:

```powershell
docker compose down
```

## Demo accounts

The seed creates one demo pharmacy (`Demo Pharmacy`, branch `Main Branch`):

| Who | Where | Sign-in |
|---|---|---|
| Demo Owner (`owner@demo.local`) | Owner panel, POS | Password from `SEED_OWNER_CREDENTIAL` (default `change-me-now`); POS PIN `SEED_OWNER_PIN` (default `1111`) |
| Demo Cashier (`cashier@demo.local`) | POS only | PIN `SEED_CASHIER_PIN` (default `1234`) |
| Pharmica Admin (`admin@pharmica.local`) | Admin panel | Password from `SEED_ADMIN_CREDENTIAL` (default `change-me-now`) |

Re-running the seed resets these credentials to the configured values.

## Demo catalogue

The seed imports `packages/database/prisma/data/master-products.demo.csv` (94 well-known medicines) and stocks about 30 of them in the demo branch. **Prices are demo fixtures, not DRAP data**, and barcodes use the GS1 in-store prefix `200`. A few items show the batch rules: Panadol, Augmentin and Brufen have an older, cheaper batch that sells first; Hydryllin is near expiry; Mucolator's only batch is expired; Lantus is low on stock. Re-running the seed resets the demo stock.

To load a real master list (for example a DRAP export converted to the same columns):

```powershell
pnpm --filter @pharmica/database db:import-master -- path\to\list.csv --source DRAP_IMPORT --reference "DRAP list Oct 2026"
```

Columns: `name, brand, generic, company, dosageForm, strength, unitsPerPack` (strips per pack), `tabletsPerStrip, officialRetailPrice, isPrescriptionOnly, isControlled, barcode, drapRegistrationNo`. Only `name` is required. Re-importing is safe: unchanged rows are skipped and price changes are added to the price history.

## POS sign-in

1. The owner registers a counter under **Staff & devices** in the owner panel, which shows a one-time activation code. The seed provides `DEMO-POS-001` for the demo counter.
2. On first start, the POS asks for that code and stores a device token. To move a counter to a new PC, the owner uses **Reset** to issue a new code.
3. Staff pick their name (or press its number) and enter their PIN. The session is bound to that device; **Lock** (F12) signs out.
4. Deactivating a device or user in the owner panel ends their sessions immediately. Five wrong passwords or PINs lock that login for 15 minutes.

## Offline billing

The POS keeps its own database (SQLite in the desktop app, IndexedDB in a browser) holding the catalogue, stock by batch, customers, staff, sales, held bills, and an outbox. Every sale, void, return, shift, and new customer is saved there first, so the counter keeps billing with no internet. The outbox uploads in order to `POST /api/v1/pos/sync` whenever the server is reachable (every 20 seconds, and immediately when the network returns), authenticated by the device token so it also drains while the counter is locked. After each upload the counter refreshes its snapshot from `GET /api/v1/pos/snapshot`.

- The counter needs the internet twice: to activate, and for each cashier's first PIN sign-in on it. After that, cashiers can sign in offline.
- The server applies each upload exactly once. It rejects anything that cannot be legitimate (unknown stock, a price above a batch's printed retail price), and accepts but flags what the owner should review (`OVERSOLD` when two counters sold the same stock offline, `DISCOUNT_OVER_LIMIT`, `CREDIT_LIMIT_EXCEEDED`). Rejected uploads stay visible on the counter under the sync status.
- Press F1 on the counter for the keyboard shortcuts.

## Stock receiving and the stock ledger

- **Receiving** happens at the counter (Ctrl+2, works offline) or in the owner panel (Purchases). Scanning a pack's GS1 2D code fills product, batch, expiry, and serial; anything the scan could not read is flagged for correction by hand. Bonus packs, line trade discounts, and an invoice discount are recorded separately, and each batch keeps its *real* cost per pack after discounts (averaged when more stock arrives for the same batch).
- **Price checks:** a printed retail price that differs from the official master price is reported to the Pharmica review queue (one report per product and price).
- **Stock control** at the counter (Ctrl+3) or owner panel (Inventory): low stock (alert level in packs), expiring within 90 days, expired stock, write-offs, damage, physical counts, rack locations. Every change needs a reason and is audited.
- **Stock ledger:** every change to a batch is a stock movement (opening, received, sold, returned, counted, written off...), so each batch's quantity always equals the sum of its movements. The owner Inventory page shows the ledger per product and confirms that stock matches it; `GET /api/v1/inventory/ledger?branchId=...` lists any batch that does not (normally none).

## Credit, suppliers, and the narcotics register

- **Customer credit (khata):** credit sales, repayments (at the counter with F3, even offline, or in the owner panel), and owner-only adjustments with a reason. Cash repayments count in the shift's expected cash. Balances are aged by the oldest unpaid credit (0-30, 31-60, 61-90, 90+ days); "overdue" means owing for more than 30 days. Each customer has a credit limit: **0 (the default for new customers) allows no credit**, an amount caps what they may owe, and "No limit" (stored as empty) is for trusted customers. Customers created before 2026-10-12 with 0 were moved to "No limit", which is how 0 behaved then.
- **Suppliers (payables):** purchases add to what the shop owes; payments are recorded by cash, bank transfer, or cheque (with a reference), plus adjustments with a reason. Owner panel → Suppliers.
- **Narcotics register:** selling a controlled (scheduled) drug at the counter requires the patient and doctor (and optionally PMDC number and prescription reference). Each entry is linked to its sale and is **append-only**: a database trigger rejects any UPDATE or DELETE, and voids or returns add REVERSAL entries. Owner panel → Register (printable). Test cleanup tooling may delete its own rows only after `SET LOCAL pharmica.allow_register_purge = 'on'`.

The end-to-end tests drive the real counter in Microsoft Edge against the API and the development database, with the internet cut mid-test:

```powershell
pnpm --filter @pharmica/pos e2e
```

There are three scenarios: offline billing (sell, void, return, restart, sync), receiving (scan a 2D code, receive with bonus, sell offline, write off, check the ledger), and credit with the register (new customer, credit sale, repayment, controlled-drug sale with prescription, shift cash). They create and then delete their own tenant (`e2e-pos-org`). It starts the API and POS dev servers if they are not already running.

## Database changes

The schema lives in `packages/database/prisma/schema.prisma` and is versioned with Prisma migrations in `packages/database/prisma/migrations`.

After editing the schema, create a migration:

```powershell
pnpm --filter @pharmica/database db:migrate -- --name <change-name>
```

Commit the generated migration folder with the schema change. Production and CI apply migrations with `db:migrate:deploy`.

## Checks

CI runs the same commands you can run locally:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
