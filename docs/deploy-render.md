# Deploying a free test environment on Render and Neon

This puts Pharmica online for testers at no cost: the database on **Neon**, the API and the three web apps on **Render**. It is a **test** environment: the demo pharmacy is seeded on every deploy with the passwords you choose below.

| Part | Where | Render name | Notes |
| --- | --- | --- | --- |
| Database | Neon, free plan | — | Sleeps when idle and wakes in about a second |
| API | Render free web service | `pharmica-api` | **Sleeps after 15 minutes without use**; the first request then takes 30–60 seconds |
| Owner panel | Render free static site | `pharmica-owner` | Always on |
| Admin panel | Render free static site | `pharmica-admin` | Always on |
| POS (browser) | Render free static site | `pharmica-pos` | Always on |

`render.yaml` in the repository describes the four Render services, and `scripts/render-build.sh` builds each one. Node 24 comes from `.node-version`, pnpm from `packageManager` in `package.json`.

## Steps

### 1. Neon: create the database
1. Sign up at neon.tech (GitHub sign-in is fine).
2. Create a project: name `pharmica-test`, region **AWS Asia Pacific (Singapore)** (closest to the Render region used here).
3. On the project dashboard, press **Connect**. Keep the default branch and database, and **turn off "Connection pooling"** (database migrations need a direct connection).
4. Copy the connection string. It looks like `postgresql://neondb_owner:…@ep-….ap-southeast-1.aws.neon.tech/neondb?sslmode=require`. Keep it private: it is the database password.

### 2. Render: account
1. Sign up at render.com with GitHub.
2. When asked, give Render access to the `Fuorix/pharmica` repository (or later: Account settings → GitHub → configure access).

### 3. Render: create the services from the Blueprint
1. In the Render dashboard: **New → Blueprint**.
2. Choose the `Fuorix/pharmica` repository, branch `main`. Render reads `render.yaml` and lists the four services.
3. Render asks for the values marked to be filled in. Enter:

| Key | Service | Value |
| --- | --- | --- |
| `DATABASE_URL` | pharmica-api | The Neon connection string from step 1 |
| `PHARMICA_ALLOWED_ORIGINS` | pharmica-api | `https://pharmica-owner.onrender.com,https://pharmica-admin.onrender.com,https://pharmica-pos.onrender.com` |
| `SEED_ADMIN_CREDENTIAL` | pharmica-api | A password for the demo admin (`admin@pharmica.local`) |
| `SEED_OWNER_CREDENTIAL` | pharmica-api | A password for the demo owner (`owner@demo.local`) |
| `SEED_OWNER_PIN` | pharmica-api | 4–6 digits, the demo owner's POS PIN |
| `SEED_CASHIER_PIN` | pharmica-api | 4–6 digits, the demo cashier's POS PIN |
| `VITE_API_URL` | pharmica-owner, pharmica-admin, pharmica-pos | `https://pharmica-api.onrender.com` |

4. Press **Apply** (or **Deploy Blueprint**). Render creates and builds all four. The API takes the longest (about 5–10 minutes); its build log ends with `Seeded owner@demo.local, cashier@demo.local, admin@pharmica.local, and POS activation code DEMO-POS-001.`

### 4. Check the addresses Render gave
Open each service in the dashboard; its address is under the name. Render uses `https://<name>.onrender.com` when that name is free, and adds a few random characters when it is not (such as `https://pharmica-api-x3k9.onrender.com`).

If any address differs from the values entered in step 3:
- **pharmica-api** address different: on each of the three static sites, Environment → edit `VITE_API_URL` to the real API address → Save → **Manual Deploy → Deploy latest commit** (the address is built into the app, so it must be rebuilt).
- **A static site's** address different: on pharmica-api, Environment → edit `PHARMICA_ALLOWED_ORIGINS` to list the real addresses (comma-separated, starting with `https://`) → Save (the API restarts by itself).

### 5. Check it works
1. Open `https://pharmica-api.onrender.com/api/v1/health` (your real API address). It shows `{"status":"ok","service":"pharmica-api",...}`. The first time after a sleep this takes up to a minute.
2. Admin panel address: sign in as `admin@pharmica.local` with `SEED_ADMIN_CREDENTIAL`.
3. Owner panel address: sign in as `owner@demo.local` with `SEED_OWNER_CREDENTIAL`.
4. POS address: activate with `DEMO-POS-001` (it works once; the owner can reset it under Staff & devices for a new code), then pick a name and enter the PIN.

### 6. Hand over to the tester
Send the three addresses (admin, owner, POS) and the passwords, with these notes:
- Use **Chrome or Edge** on a computer. Safari and Firefox block the sign-in cookie between `onrender.com` addresses.
- If a panel says it **cannot reach Pharmica**, the API is waking up: wait a minute and try again.
- To test a new pharmacy end to end: admin panel → Pharmacies → New pharmacy (the temporary password is shown once) → owner panel sign-in → Staff & devices for PINs and activation codes → POS.
- Offline billing: once the POS has loaded its catalogue, switch the internet off and keep billing; it uploads when the internet is back. Do not reload the POS page while offline, because the browser needs the internet to load the page itself.

## Updating
Work goes through pull requests: GitHub Actions (`.github/workflows/ci.yml`) runs lint, type checks, tests, and the build on every pull request and again on `main` after the merge. Render deploys a merge to `main` only after those checks pass (`autoDeployTrigger: checksPass` in `render.yaml`); if they fail, the running version stays up and nothing is deployed. The API build also applies new database migrations and re-seeds the demo pharmacy, which resets the demo passwords and PINs to the values above.

To keep untested code out of `main`, protect it on GitHub: repository Settings → Branches (or Rules → Rulesets) → a rule for `main` that requires a pull request before merging and requires the `validate` status check to pass.

Free limits to keep in mind: Render's free plan includes a monthly allowance of build minutes, and each merge builds all four services (roughly 10–15 minutes in total), so avoid pushing many small merges in a row. The sleeping API does not count against you.

## If something fails
- **pharmica-api build stops at "Set … " right away**: a value from step 3 is missing; add it under Environment and deploy again.
- **Database errors during the API build** (`P1001`, connection refused, or a migration error mentioning a pooler): check `DATABASE_URL` is Neon's string with connection pooling **off**, ending in `?sslmode=require`.
- **API build runs out of memory** (`JavaScript heap out of memory` or the build is killed): tell the developer; the build may need trimming for the free plan's memory.
- **A panel shows "Cannot reach Pharmica" for more than a couple of minutes**: open the health address; check the panel's `VITE_API_URL` (and redeploy it after changing it) and the API's `PHARMICA_ALLOWED_ORIGINS` (it must list that panel's exact address).
- **Sign-in seems to work but the next page is signed out**: the browser dropped the cookie; use Chrome or Edge.

## Before real use
For live shops, move to a paid always-on API, use your own domain for all four addresses (then remove `SESSION_COOKIE_SAMESITE`), stop seeding demo data in `scripts/render-build.sh`, keep database backups, and ship the POS as the Windows app.
