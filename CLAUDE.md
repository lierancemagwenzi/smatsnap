# CLAUDE.md

## Running

```bash
npm install
cp .env.example .env      # then fill in DB + DEV_SECRET
npm run migrate           # sequelize-cli db:migrate
npm run dev               # nodemon app.js (default port 8010)
npm test                  # node --test (event matcher)
npm run faces:reindex     # after changing FACE_PROVIDER
```

Face service (FACE_PROVIDER=local, started/restarted by app.js):
```bash
cd face-service && python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt && ./download_models.sh
```

Local dev DB is XAMPP MariaDB on **port 3308** (`DEV_DB_PORT`). Mail goes through SendGrid SMTP (tese-backend's key); with `SMTP_HOST` empty in development, OTPs are printed to the console instead. S3: bucket `smatechgroup-photo-sharing-app` (af-south-1) with tese-backend's S3 credentials. Express is **v5** — no regex route params (`creator_routes.js` validates `:id` with `app.param`).

## Architecture (same layering as tese-backend)

```
HTTP → app.js → app-routes/*.js → middleware/ → handlers/*.js → models/ → MySQL
```

- `app-routes/` — route files per area, each `module.exports = function(app)` registered in `app.js`.
- `handlers/` — all business logic: `RegistrationHandler.js` (auth + photographer payout account at signup), `EventHandler.js` (shared event search + candidate retrieval), `creatorHandler.js` (events, joining, pricing, uploads, payout setup, sales from our ledger), `client_handler.js` (client events, face search, matches), `PaymentHandler.js` (checkout via each photographer's gateway, webhooks, orders, purchases, downloads).
- `helpers/payments/` — gateway-independent payments: provider interface + registry (`index.js`), country → gateway routing (`countries.js`: ZW → SmatPay, ZA/NG/GH/KE → Paystack), `providers/smatpay.js`, `providers/paystack.js`, `PaymentError`. `helpers/smatpay/` holds SmatPay's low-level API (modelled on tese-backend and `../whatsapp/smatpay_whatsapp`). `helpers/paymentTracker.js` polls pending orders with their own gateway (10 s) and applies webhooks. See `docs/payments-api.md`.
- `helpers/faces/` — swappable face matching (`local` = `face-service/` + embeddings in MySQL, `rekognition`). See `docs/client-api.md`.
- `helpers/videoTools.js` — ffmpeg (bundled `ffmpeg-static`): probe, poster, watermarked preview clip, frame sampling.
- `middleware/authentication.js` — `authenticateToken` (access, verified users), `authenticateOtpToken`, `authenticateResetToken`. Sets `req.user` (JWT claims) and `req.dbUser` (Sequelize row).
- `middleware/user_type.js` — `userType('creator')` guard for role-specific routes.
- `middleware/rate_limit.js` — `authLimiter`, `emailLimiter`.
- `helpers/tokens.js` — JWTs with a `purpose` claim (`access` 1h, `refresh` 30d, `otp` 15m, `reset` 15m). `issueSession()` rotates the refresh token (hash stored in `users.refresh_token_hash`).
- `helpers/otp.js` — 6-digit OTPs, bcrypt-hashed on the user row, 10 min TTL, 5 attempts, 60s resend cooldown.
- `helpers/env.js` — environment switches (JWT secret, S3 bucket/region).
- `services/s3client.js` + `helpers/amazonHelper.js` — presigned PUT/GET, head, delete.
- `helpers/eventMatcher.js` — fuzzy duplicate detection for shared events (pure functions, unit-tested in `test/`).
- `helpers/mediaProcessor.js` — scheduled jobs: photo thumbnails + watermarked previews (sharp), 7-day expiry.
- `helpers/pricing.js` — price parsing; `effectivePrice(media.price, membership.price)`.
- `models/` — Sequelize models (`underscored: true`); schema changes go in `migrations/`.

## Auth rules
- OTP is required only while `email_verified_at` is NULL (new signups, or unverified users logging in). Verified users get tokens straight from `/api/auth/login`.
- Never return OTPs or password/token hashes in responses (`user.toPublicJSON()`).
- Forgot-password responds identically whether or not the email exists.

## Events & media rules
See `docs/events-api.md`. Key invariants:
- Events are shared; never create one without running `EventHandler.findMatchingEvents` (CreateEvent does this server-side).
- Photographers only ever see/modify their own media; access is gated by an `event_photographers` row.
- Media expires 7 days after upload completes; files are uploaded directly to S3, never through the API.

## Payments rules
- Never call a gateway directly from handlers — go through `helpers/payments` (provider of the photographer's `payout_accounts` row; the order's `provider` for tracking). New gateways = new `providers/*.js` + routing, nothing else.
- Every photographer must have a `ready` payout account to sell; its currency is their selling currency. SmatPay signup is tese's content-creator signup with `SMATPAY_PRODUCT_CODE` (`Tese` borrowed for sandbox only — refused on production).
- Gateway credentials are only ever stored encrypted (`TOKEN_ENCRYPTION_KEY`) and never returned; bank account numbers are kept as last 4 digits only.
- Webhooks are signature-checked and the payment is re-verified with the gateway before unlocking.
- Never trust client prices: checkout recomputes from `media.price ?? event_photographers.price`.
