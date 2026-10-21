# Client API — find events, face search, matches

All routes need `Authorization: Bearer <access token>`; `/api/client/*` also requires `user_type = client`.

| Request | Response |
|---|---|
| `GET /api/events/search?q=` | Same as photographers. A 6-character event code (e.g. `9SM4WN`) returns that event directly. |
| `GET /api/client/events` | `{events:[{...event, match_count, last_searched_at}]}` — events this client searched |
| `GET /api/client/events/:id` | `{event:{...event, photographer_count, media_count}, searched, last_searched_at, face_consent, matches:[...]}` |
| `POST /api/client/events/:id/face-search` multipart `selfie` (image ≤ 10 MB), `consent=true` the first time | `{message, matches:[...]}` · 428 `CONSENT_REQUIRED` · 422 `NO_FACE` / `MULTIPLE_FACES` / `FACE_TOO_SMALL` · rate limit 20/h per user |
| `POST /api/client/matches/:mediaId/hide` | "Not me" — hidden from this client, also after re-searching |

Match JSON: `{media_id, type, width, height, duration_seconds, thumb_url, preview_url, price, currency, photographer:{id, name}, similarity, appears_at:[seconds], expires_at}`.
`thumb_url` / `preview_url` are **watermarked** (photo: 600px / 1600px JPEG; video: poster / 15 s 480p MP4). Original keys are never sent to clients.

Privacy rules:
- The selfie is processed in memory and never stored. Consent is recorded once in `users.face_consent_at`.
- Clients only see media their own face matched (`client_matches`).
- Face data (`media_faces`) is deleted with the media (7-day expiry or photographer delete).

## Face matching (`helpers/faces/`)
`FACE_PROVIDER=local` (default) or `rekognition`; both implement `indexMedia / search / removeMedia`.
- **local**: `face-service/` (Python, OpenCV YuNet + SFace, MIT/Apache-2.0) returns 128-d embeddings; stored in `media_faces.embedding`, matched by cosine similarity in Node (`LOCAL_FACE_THRESHOLD`, default 0.42). Detection runs at two scales (1600px for crowds, 640px for close-ups).
- **rekognition**: one collection per event in `REKOGNITION_REGION` (us-east-1; not available in af-south-1), `FACE_MATCH_THRESHOLD` percent.
- After switching: `npm run faces:reindex`.

Processing (`helpers/mediaProcessor.js`): photos → clean thumb, watermarked thumb + preview, faces from a 1600px copy. Videos → streamed to a temp file → poster frame, watermarked 15 s preview clip, one frame every 2 s (≤ 150) → faces with their timestamps. Failed indexing is retried every 10 min.
