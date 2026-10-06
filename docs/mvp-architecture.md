# Pharmica MVP Architecture

## Repository boundaries

The main repository is a pnpm/Turborepo monorepo containing the shared backend and three clients:

- `apps/api`: one Next.js API for the POS, owner panel, admin panel, and future mobile app
- `apps/pos`: React POS UI with a Tauri desktop shell
- `apps/owner-web`: owner dashboard across branches
- `apps/admin-web`: internal tenant, catalogue, and collections panel
- `packages/contracts`: API request/response and domain types
- `packages/api-client`: typed client used by every frontend
- `packages/database`: Prisma schema for tenancy, inventory, batches, and sales

The owner mobile app will live in a separate repository and consume the versioned API contract/client generated from this backend.

## MVP vertical slices

1. Authentication and organisation/branch/device/user permissions
2. Product catalogue, batch inventory, expiry, and barcode lookup
3. Offline POS sale creation with cash, card, and credit payment methods
4. Sync queue and conflict-safe server ingestion
5. Owner dashboard, stock alerts, credit ledger, and exports
6. Admin tenant onboarding, catalogue price review, subscriptions, and collections
7. ~~FBR invoice submission and retry status~~ (excluded from the MVP; planned after it)

The current scaffold contains the runnable application shells, shared contracts, health endpoint, and initial database schema. Domain modules should be added one vertical slice at a time.

## Commands

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm build
```

App URLs during development:

- API: `http://localhost:4000`
- Owner panel: `http://localhost:3000`
- Admin panel: `http://localhost:3001`
- POS browser shell: `http://localhost:3002`
