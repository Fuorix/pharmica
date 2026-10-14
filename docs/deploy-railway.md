# Deploying a test environment on Railway

This puts Pharmica online so testers can use the admin panel, the owner panel, and the POS in a browser. It is a **test** environment: the demo pharmacy is seeded on every deploy and the demo passwords come from the variables below.

## What runs where

One Railway project with five services, all built from this repository's `main` branch:

| Service name | What it is | Build command | Start command |
| --- | --- | --- | --- |
| `Postgres` | Database (Railway template) | — | — |
| `api` | Next.js API | `pnpm railway:api:build` | `pnpm railway:api:start` |
| `owner` | Owner panel | `pnpm --filter @pharmica/owner-web build` | `node scripts/serve-static.mjs apps/owner-web/dist` |
| `admin` | Admin panel | `pnpm --filter @pharmica/admin-web build` | `node scripts/serve-static.mjs apps/admin-web/dist` |
| `pos` | POS in the browser | `pnpm --filter @pharmica/pos build` | `node scripts/serve-static.mjs apps/pos/dist` |

Use exactly these service names: the variables below refer to services by name (`${{api.…}}`).

Every service keeps the **root directory empty** (the repository root), because the apps share packages in `packages/`. Node 24 comes from `.node-version` and pnpm from `packageManager` in `package.json`.

## Steps

### 1. Account and project
1. Sign up at railway.com with GitHub. A trial gives some free credit; a test environment of this size fits the Hobby plan.
2. Give Railway access to the `Fuorix/pharmica` repository when it asks (GitHub → Settings → Applications → Railway → repository access).
3. **New Project → Deploy from GitHub repo → Fuorix/pharmica.** This creates the first service. Rename it to `api` (service → Settings → Service name). Its first build may fail before it is configured; that is fine.

### 2. Database
In the project: **+ Create → Database → PostgreSQL.** Keep the name `Postgres`.

### 3. The other three services
Three times: **+ Create → GitHub Repo → Fuorix/pharmica**, and rename them `owner`, `admin`, and `pos`.

### 4. Public addresses
For each of `api`, `owner`, `admin`, `pos`: **Settings → Networking → Generate Domain.** If it asks for a port, use the port the deploy logs show (the apps listen on Railway's `PORT`; usually 8080). Each gets an address like `https://api-production-xxxx.up.railway.app`.

### 5. Settings for `api`
Settings tab:
- Source: branch `main`.
- Build → Custom Build Command: `pnpm railway:api:build`
- Deploy → Pre-deploy Command: `pnpm railway:api:predeploy` (applies database migrations, then seeds the demo data)
- Deploy → Custom Start Command: `pnpm railway:api:start`
- Deploy → Healthcheck Path: `/api/v1/health`

Variables tab (Raw Editor), choosing your own passwords:
```
DATABASE_URL=${{Postgres.DATABASE_URL}}
PHARMICA_ALLOWED_ORIGINS=https://${{owner.RAILWAY_PUBLIC_DOMAIN}},https://${{admin.RAILWAY_PUBLIC_DOMAIN}},https://${{pos.RAILWAY_PUBLIC_DOMAIN}}
SESSION_COOKIE_SAMESITE=none
SEED_ADMIN_CREDENTIAL=<admin password for testers>
SEED_OWNER_CREDENTIAL=<demo owner password for testers>
SEED_OWNER_PIN=<4-6 digits>
SEED_CASHIER_PIN=<4-6 digits>
```
`SESSION_COOKIE_SAMESITE=none` is needed only while the apps use the separate `*.up.railway.app` addresses (see "Own domain" below). Without the seed variables the demo passwords fall back to the public defaults in `development-setup.md`, so always set them.

Optional: `PHARMICA_PAY_INSTRUCTIONS` (text shown on the owner subscription page).

### 6. Settings for `owner`, `admin`, `pos`
For each, Settings tab:
- Source: branch `main`.
- Custom Build Command and Custom Start Command from the table above.
- No pre-deploy command and no healthcheck path are needed.

Variables tab, the same line for all three:
```
VITE_API_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}
```
The API address is built into these apps, so after changing it, redeploy them.

### 7. Deploy
Deploy `api` first (Deployments → Deploy, or it deploys on its own after settings change). Wait until it is **Active**: its pre-deploy log should end with `Seeded owner@demo.local, cashier@demo.local, admin@pharmica.local, and POS activation code DEMO-POS-001.` Then deploy `owner`, `admin`, and `pos`.

### 8. Check
- `https://<api address>/api/v1/health` shows `{"status":"ok","service":"pharmica-api",...}`.
- The admin address: sign in as `admin@pharmica.local` with `SEED_ADMIN_CREDENTIAL`.
- The owner address: sign in as `owner@demo.local` with `SEED_OWNER_CREDENTIAL`.
- The POS address: activate with `DEMO-POS-001` (once only; the owner can reset it under Staff & devices for a new code), then sign in with a PIN.

## For testers
- Use **Chrome or Edge** on a computer. With the `*.up.railway.app` addresses, Safari and Firefox block the sign-in cookie.
- To test a new pharmacy end to end: admin panel → Pharmacies → New pharmacy (note the temporary password, shown once) → owner panel sign-in → Staff & devices for PINs and activation codes → POS.
- Offline billing: once the POS has loaded and downloaded its catalogue, switch the internet off and keep billing. Do not reload the POS page while offline: the browser version needs the internet to load the page itself (the Windows app does not).

## Updating
Every push or merge to `main` rebuilds and redeploys all four services by themselves. Database migrations run in the `api` pre-deploy step before the new API starts.

## Own domain (recommended before real shops)
With a domain you own, add custom domains such as `api.test.example.com`, `owner.test.example.com`, `admin.test.example.com`, and `pos.test.example.com` (service → Settings → Networking → Custom Domain, then add the CNAME records Railway shows at your domain registrar). Then:
- `PHARMICA_ALLOWED_ORIGINS` lists those `https://` addresses,
- `VITE_API_URL` is `https://api.test.example.com` (and redeploy the three apps),
- remove `SESSION_COOKIE_SAMESITE`, so the cookie stays first-party and every browser works.

## Before real use
This setup is for testing. For live shops: remove `railway:api:predeploy`'s seed step (use `pnpm --filter @pharmica/database db:migrate:deploy` alone) so demo accounts are not created, use the own-domain setup, turn on Railway's Postgres backups, and ship the POS as the Windows app rather than the browser version.

## If something fails
- **Build fails with "Cannot find module" or Prisma errors** in `api`: check the build command is `pnpm railway:api:build` (it generates the Prisma client first).
- **Pre-deploy fails with a database error**: check `DATABASE_URL=${{Postgres.DATABASE_URL}}` and that the database service is named `Postgres`.
- **Panels show "Cannot reach Pharmica"**: open the API health address; check `VITE_API_URL` on the panel (and redeploy it after changing it) and `PHARMICA_ALLOWED_ORIGINS` on `api` (it must list the panel's exact `https://` address, no trailing slash needed).
- **Sign-in seems to work but the next page says signed out**: the browser dropped the cookie. Use Chrome or Edge, check `SESSION_COOKIE_SAMESITE=none` on `api`, or switch to your own domain.
