# Auth API

Base: `http://<host>:8010/api`. JSON bodies. Errors are `{ "message": "..." }`.

`user` objects: `{ id, name, lastname, email, user_type: "creator"|"client", status, email_verified_at }`.

| Step | Request | Success |
|---|---|---|
| Check email | `POST /registration/check-email` `{email}` | `{available}` |
| Register | `POST /registration/register` `{name, lastname, email, password, user_type}` | **201** OTP-step body (below). 409 if email taken. Password: 8+ chars, letter + number |
| Login | `POST /auth/login` `{email, password}` | Verified: `{requires_otp:false, token, refresh_token, user}`. Unverified: OTP-step body. 401 bad credentials |
| Verify OTP | `POST /auth/verify-otp` · Bearer `otp_token` · `{otp}` | `{token, refresh_token, user}` (sets `email_verified_at`) |
| Resend OTP | `POST /auth/resend-otp` · Bearer `otp_token` | `{message, resend_in}`; 429 during cooldown |
| Forgot password | `POST /auth/forgot-password` `{email}` | Always `{message, resend_in}` |
| Verify reset code | `POST /auth/verify-reset-otp` `{email, otp}` | `{reset_token}` |
| Reset password | `POST /auth/reset-password` · Bearer `reset_token` · `{password}` | `{token, refresh_token, user}`; other devices are signed out; token is single-use |
| Refresh | `POST /auth/refresh-token` `{refresh_token}` | `{token, refresh_token, user}` (rotated; replaying an old refresh token revokes the session) |
| Logout | `POST /auth/logout` · Bearer access | `{message}` |
| Account | `GET /auth/get-account` · Bearer access | `{user}` |

OTP-step body: `{ message, requires_otp: true, otp_token, resend_in, user }`.

OTP codes: 6 digits, 10-minute expiry, 5 wrong attempts max, 60 s between sends. Access tokens last 1 h, refresh tokens 30 days.
