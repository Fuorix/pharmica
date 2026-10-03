# Pharmica

Pharmica is an offline-first pharmacy POS SaaS for Pakistani medical stores.

This repository is the MVP monorepo for one shared backend and three clients:

- `apps/api`: Next.js backend for all clients
- `apps/pos`: React POS with a Tauri desktop shell
- `apps/owner-web`: pharmacy owner dashboard
- `apps/admin-web`: Pharmica super-admin panel
- `packages/contracts`: shared API and domain types
- `packages/api-client`: shared typed API client
- `packages/database`: Prisma schema and database package

The owner mobile app will be developed in a separate repository and will consume the backend API contract.

## Start

Requires Node.js 24+ and pnpm 10+.

```bash
pnpm install
pnpm dev
```

For local database and Redis setup, run `./scripts/prepare-dev.ps1` first. See [docs/development-setup.md](docs/development-setup.md) for details.

See [docs/mvp-architecture.md](docs/mvp-architecture.md) for the MVP boundary and development URLs.