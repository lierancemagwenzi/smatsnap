# Events & Media API (photographers)

All routes need `Authorization: Bearer <access token>`; `/api/creator/*` also requires `user_type = creator`.

## Shared events and duplicate prevention

One real-world event = one `events` row. Photographers **join** it (`event_photographers`) with their own default price. Matching lives in `helpers/eventMatcher.js` (normalisation, abbreviations, typos via Jaro–Winkler, sound-alike codes, acronyms, containment, conflicting-word detection, date proximity). Levels:

| level | meaning | on create |
|---|---|---|
| `exact` | same canonical name, overlapping dates | **blocked** — 409 `EVENT_EXISTS` |
| `likely` | score ≥ 0.78 | 409 `POSSIBLE_DUPLICATES` unless `confirm_new: true` |
| `similar` | score ≥ 0.45 | shown in search only |

Same name more than 3 days apart (or different years in the name) = a different edition. A unique index on `(name_key, start_date)` stops simultaneous duplicates.

| Request | Response |
|---|---|
| `GET /api/events/search?q=&date=YYYY-MM-DD` | `{results:[{event, match, score, photographer_count, media_count, joined}]}` |
| `POST /api/creator/events` `{name, venue?, city?, start_date, end_date?, price, confirm_new?}` | 201 `{event, membership}` · 409 `{code, message, matches}` |
| `POST /api/creator/events/:id/join` `{price}` | 201 `{event, membership}` · 409 if already joined |
| `GET /api/creator/events` | `{events:[{...event, membership, my_media_count, photographer_count, is_owner}]}` |
| `GET /api/creator/events/:id` | `{event, membership, photographer_count, retention_days, media:[...]}` (own media only) |
| `PUT /api/creator/events/:id/price` `{price}` | `{membership}` |
| `GET /api/creator/dashboard` | `{live_events, uploads, earned, currency}` |

## Pricing
`membership.price` is the photographer's default for the event. `media.price` (nullable) overrides it; `effective_price = media.price ?? membership.price`. Prices: 0–10000, ≤ 2 decimals, USD.

## Uploads (direct to S3)

Files never pass through the API. Up to 16 MB → one presigned PUT; larger → S3 multipart (8 MiB parts), which can resume after a dropped connection and send parts in parallel.

1. `POST /api/creator/events/:id/media/upload-urls` `{files:[{filename, content_type, size}]}` (≤ 50)
   - photos: jpeg/png/webp/heic/heif ≤ 50 MB · videos: mp4/quicktime/x-m4v ≤ 2 GB
   - single: `{media_id, type, mode:"single", method:"PUT", upload_url, headers, expires_in}` — URL signed for the exact `Content-Type` and size, valid `UPLOAD_URL_TTL_HOURS` (default 24 h)
   - multipart: `{media_id, type, mode:"multipart", part_size, part_count}` — the S3 UploadId stays server-side
2. Send the bytes:
   - single: `PUT upload_url` with `headers`
   - multipart: `POST /api/creator/media/:id/parts` `{part_numbers:[…]}` (≤ 50) → `{parts:[{part_number, size, offset, url}], expires_in}`; `PUT` bytes `[offset, offset+size)` to each `url` (signed for that exact length, valid `PART_URL_TTL_HOURS`, default 6 h). Request URLs just before sending; ask again for fresh ones if they expire.
   - resume: `GET /api/creator/media/:id/parts` → `{part_size, part_count, uploaded:[part numbers S3 has]}`
3. `POST /api/creator/media/:id/complete` — multipart is assembled from S3's own part list (client sends no ETags); 409 if parts are missing. Verifies the object and starts the **7-day** retention clock. Photos go `uploaded → processing → ready` (thumbnail 480px + watermarked 1600px preview); videos are `ready` immediately. Idempotent.

Deleting an in-progress upload aborts the multipart upload; the expiry job aborts uploads abandoned for 24 h.

| Request | Response |
|---|---|
| `PUT /api/creator/media/:id/price` `{price: number \| null}` | `{media}` — `null` reverts to the event price |
| `DELETE /api/creator/media/:id` | removes original/thumb/preview from S3 |

Media JSON: `{id, type, status, filename, size_bytes, width, height, price, effective_price, thumb_url, url, error, uploaded_at, expires_at}` — URLs are presigned for 1 h.

S3 layout: `events/{eventId}/{creatorId}/{originals|thumbs|previews}/{uuid}.ext`.

## Background jobs (app.js, node-schedule)
- every 10 s `mediaProcessor.processUploadedMedia` — 3 photos per tick, claimed atomically
- every 15 min `mediaProcessor.expireMedia` — deletes media past `expires_at`, and `pending` uploads older than 24 h
