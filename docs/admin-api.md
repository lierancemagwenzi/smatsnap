# Admin API

Used by the admin dashboard (`photo-admin/`, served under `/admin`). All routes need an access
token from an **admin** account (`user_type: 'admin'`) except login. Errors are `{ message }`
(sometimes with `code`).

Roles (`users.admin_role`): `super_admin` (everything, including managing admins) and `admin`
(everything except `/api/admin/admins`). Every change an admin makes is written to `admin_actions`.

## Accounts

- First super admin: `npm run admin:create -- --email you@example.com --name Jane --lastname Doe [--password ...]`
  (prints a generated password once if none is given). Later admins are added from the dashboard.
- Admin accounts can't sign in to the app: `POST /api/auth/login` answers 403 for them.
- New admins are created without a usable password and emailed a link to
  `<ADMIN_DASHBOARD_URL>/set-password?email=…`, which runs the normal forgot-password flow
  (`/api/auth/forgot-password` → `/api/auth/verify-reset-otp` → `/api/auth/reset-password`).
  Confirming that code also verifies their email.
- Refresh, logout and get-account use the shared `/api/auth/*` routes (see `auth-api.md`).

## Endpoints

| Method | Path | Notes |
|---|---|---|
| POST | `/api/admin/auth/login` | `{ email, password }` → `{ token, refresh_token, user }`. 403 `PASSWORD_NOT_SET` for invited admins who haven't set one. |
| GET | `/api/admin/stats?days=30` | Users, events, media, orders (per currency), payouts, daily `series.signups` / `series.sales` (UTC, zero-filled), top events and photographers. `days` 7–365. |
| GET | `/api/admin/system` | DB, face service, email, storage, gateways (configured / test mode / countries), background queues. |
| GET | `/api/admin/users?type=creator\|client&status=active\|suspended&verified=true\|false&q=&page=&size=` | Clients and photographers only. |
| GET | `/api/admin/users/:id` | `user` (+ payout), `stats` (creator: earnings, items sold, events, media; client: spent, purchases, searches, matches), `recent_orders`. |
| PUT | `/api/admin/users/:id/status` | `{ status: 'active'\|'suspended', reason? }`. Suspending clears the refresh token; access tokens stop working immediately. |
| GET | `/api/admin/events?status=active\|hidden&q=&page=&size=` | With photographer, live media and paid order counts. |
| GET | `/api/admin/events/:id` | Event, photographers (price, live media), media by status, sales per currency, searches, matches. |
| PUT | `/api/admin/events/:id/status` | `{ status: 'active'\|'hidden', reason? }`. Hidden events drop out of client search and can't be joined. |
| GET | `/api/admin/events/:id/media?creator_id=&type=photo\|video&status=&page=&size=` | Watermarked `thumb_url` / `preview_url` (presigned, 1 h), times sold. Deleted/pending excluded unless `status` asks. |
| DELETE | `/api/admin/media/:id?force=true` | Body `{ reason? }`. Purges files + face data. 409 `PURCHASED` if buyers can still download; repeat with `force=true` to revoke them too. |
| GET | `/api/admin/orders?status=&provider=&currency=&q=&event_id=&creator_id=&client_id=&from=YYYY-MM-DD&to=YYYY-MM-DD&page=&size=` | `q` matches reference / payment code. Response includes `filters` (providers, currencies, statuses in use). |
| GET | `/api/admin/orders/:id` | Order (+ payment code, payer mobile) and items with thumbnails and download windows. |
| POST | `/api/admin/orders/:id/recheck` | PENDING/EXPIRED only: asks the gateway now (`paymentTracker.checkOrder(force)`). |
| GET | `/api/admin/payouts?provider=&status=&country=&q=&page=&size=` | Payout accounts (no credentials) with the photographer and earnings per currency. |
| GET | `/api/admin/activity?admin_id=&target_type=&target_id=&page=&size=` | Audit log, newest first. |
| GET | `/api/admin/admins` | **super_admin**. `password_set`, `is_me`. |
| POST | `/api/admin/admins` | **super_admin**. `{ name, lastname, email, admin_role }` → invite email; returns `set_password_url` when `ADMIN_DASHBOARD_URL` is set. |
| PUT | `/api/admin/admins/:id` | **super_admin**. `{ admin_role?, status? }`. Not yourself; there must always be one active super admin. |
| DELETE | `/api/admin/admins/:id` | **super_admin**. Only for invites that never set a password (others are suspended instead). |

Lists return `{ page, size, total, <items> }` (`size` ≤ 100).
