# Payments — gateway-independent payouts & checkout

The app isn't tied to one payment gateway. Each photographer has one **payout account**
(`payout_accounts`) with the gateway of **their country**; clients anywhere pay that gateway, and
the money lands with the photographer in their currency. The platform fee goes on top.

| Country | Currency | Gateway | Photographer is… | Platform fee travels as |
|---|---|---|---|---|
| ZW Zimbabwe | USD | SmatPay | a SmatPay merchant (tese-style content-creator signup) | `additionalFees` |
| ZA South Africa | ZAR | Paystack | a Paystack **subaccount** settling to their bank | `transaction_charge` |
| NG Nigeria | NGN | Paystack | 〃 | 〃 |
| GH Ghana | GHS | Paystack | 〃 | 〃 |
| KE Kenya | KES | Paystack | 〃 | 〃 |

Routing lives in `helpers/payments/countries.js` (override with `PAYMENT_ROUTES=ZW:smatpay,…`).
A country is only offered when its gateway is configured.

## Code layout
- `helpers/payments/index.js` — the provider interface (documented at the top), registry, `countries()`, `forCountry()`, `checkOnboarding()` / `createAccount()` / `openAccount()`, `readyAccount()`.
- `helpers/payments/providers/smatpay.js` — SmatPay (key sign-in sessions, EcoCash/O'mari/InnBucks/ZimSwitch/Visa/Mastercard, `trackPaymentTransaction`, payout balance). Low-level calls: `helpers/smatpay/*`.
- `helpers/payments/providers/paystack.js` — Paystack (banks list, account resolve for NG/GH, subaccounts, hosted checkout, `transaction/verify`, signed webhook).
- `helpers/payments/common.js` — fee, references, timeouts. `helpers/payments/paymentError.js` — `PaymentError` (all gateway failures) with `httpStatus()`.
- `helpers/paymentTracker.js` — polls pending orders with **their order's** gateway every 10 s, applies webhooks.

**Adding a gateway:** write `providers/<name>.js` implementing the interface, register it in `PROVIDERS`, route countries to it. Handlers and the app don't change — the payout form is rendered from the field schema the provider returns, and checkout methods come per group.

## Config (.env)
| Key | Meaning |
|---|---|
| `PAYMENT_ROUTES` | optional per-country override, e.g. `ZA:paystack` |
| `API_PUBLIC_URL` | public HTTPS base of the API (Paystack `callback_url` + webhook) |
| `PAYSTACK_SECRET_KEY` | `sk_test_…` / `sk_live_…` — enables ZA/NG/GH/KE. Webhook URL to set in the Paystack dashboard: `<API_PUBLIC_URL>/api/payments/paystack/webhook` |
| `SMATPAY_API_URL` | `https://dev.smatpay.africa:8443` (dev) / `https://live.smatpay.africa` |
| `SMATPAY_PLANE` | `sandbox` or `production` |
| `SMATPAY_PRODUCT_CODE` | product code for content-creator signup — `Tese` for sandbox only until ours is issued (refused on production) |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64 — encrypts stored gateway credentials (AES-256-GCM) |
| `PLATFORM_FEE_PERCENT` / `PLATFORM_FEE_FIXED` | fee added on top: `subtotal × percent + fixed` |
| `PURCHASE_DOWNLOAD_DAYS` | how long buyers can download originals (default 30) |

## Photographer payout account
- `GET /api/registration/payout-countries` → `{countries:[{code, name, currency, provider, provider_label}]}`
- `GET /api/registration/payout-form?country=ZW&name=&lastname=` → `{country, intro, fields:[{key, label, type: text|number|phone|date|select, required, options?:[{value,label}], style?: 'chips', placeholder?, default?, min_age?}]}` — the app renders it as is. SmatPay: title, gender, date of birth (18+), phone, business name/description/address, province. Paystack: business name, bank (Paystack's list for the country), account number, mobile.
- `POST /api/registration/register` with `user_type: "creator"` **requires** `payout: {country, values:{<field key>: value}}`. The user row and the gateway account are created in one transaction — a gateway refusal leaves no account behind (400/502, `field: "payout"`).
- Older accounts: `GET /api/creator/payout` → `{payout_ready, payout:{provider, provider_label, country, currency, status, approved, account_id, display_name, test_mode, summary}}`; `POST /api/creator/payout` `{country, values}`.
- Creating/joining events and uploading return **403 `PAYOUT_REQUIRED`** until set up. Event prices are in the payout account's currency (`event_photographers.currency`).
- Stored: SmatPay keys only encrypted (`credentials_enc`); Paystack keeps only the subaccount code, bank name and the account's **last 4 digits**. Nothing secret is ever returned.

## Sales (photographer)
From **our own order ledger**, the same for every gateway, plus the gateway's balance when it has one.

| Request | Response |
|---|---|
| `GET /api/creator/sales/summary` | `{payout_ready, payout, earned, sales, items_sold, currency, balances:[{currency, amount}] \| null, balance_error, balance_note}` — SmatPay: `balances` from `merchantPayoutBalance`; Paystack: `balances: null` + `balance_note` (settles to the bank automatically) |
| `GET /api/creator/sales/transactions?page=&size=` (≤ 50) | `{page, size, total, transactions:[{id, reference, amount (photographer's share), fee, currency, provider, method, status: Paid\|Pending\|Failed\|Cancelled, payer, created_at, paid_at, order:{id, event, item_count, status}}]}` — newest first; expired checkouts left out |

## Checkout (client)
| Request | Response |
|---|---|
| `POST /api/client/checkout/quote` `{media_ids}` | `{groups:[{creator_id, event_id, photographer, trading_name, can_pay, provider, provider_label, methods:[{id, label, wallet, kind, needs_mobile, mobile_hint, usd_only}], media_ids, currency, subtotal, fee, total}], problems, fee}` — one group per photographer+event, each with **its gateway's** methods |
| `POST /api/client/checkout` `{media_ids, method, payer_mobile?}` | 201 `{order, next:{kind: prompt\|code\|redirect\|none, payment_code, redirect_url, message}}` · 409 `CART_CHANGED` · 400 `MULTIPLE_PHOTOGRAPHERS` · 409 `NOT_READY` |
| `GET /api/client/orders/:id` | `{order}` — also checks the gateway immediately while pending |
| `GET /api/client/orders` | recent orders |
| `GET /api/client/purchases` | owned media (clean thumbnails), `download_until` |
| `GET /api/client/purchases/:mediaId/download` | `{url, filename, mime_type, taken_at, expires_in: 900}` — original file, attachment |
| `POST /api/payments/:provider/webhook` | gateway notifications; signature checked (Paystack: `x-paystack-signature`, HMAC-SHA512 of the raw body) and every reference **re-verified** with the gateway before anything unlocks |
| `GET /api/payments/:provider/return` | static "payment submitted" page hosted checkouts return to (the app's WebView closes on it) |

Methods: SmatPay — `ECOCASH` (prompt, `07[78]…`), `OMARI` (prompt, `071…`), `INNBUCKS` (code, USD only), `ZIMSWITCH` / `VISA` / `MASTERCARD` (redirect). Paystack — `PAYSTACK` (redirect to Paystack's page: card, bank, mobile money where the country has it).

Rules: only media the client's **own face matched**, still live and not already owned can be bought; prices are recomputed server-side; a repeat checkout for the same items returns the still-pending order (no double charge); free items are granted without a gateway.

Flow: order saved `PENDING` with its `provider` → `provider.createPayment` (SmatPay: key sign-in + `init/authenticate/merchant/wallet`; Paystack: `transaction/initialize` with `subaccount`, `transaction_charge` = fee, `bearer: subaccount`) → `paymentTracker` polls `provider.checkPayment` every 10 s (and on webhooks) → `PAID` creates `purchases` (+ emails); failed/cancelled → closed; pending > 30 min → `EXPIRED`, re-checked every 5 min for 24 h so late payments still unlock.

Retention: bought originals outlive the event's 7 days until `download_until`; their face data is still removed at 7 days.
