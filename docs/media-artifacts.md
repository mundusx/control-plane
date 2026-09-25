# Image upload and 48-hour download links

The web server (`apps/chat`) stores PNG files on a private persistent volume and
keeps metadata in native PostgreSQL. Supabase is not required. Download links do
not require a login: anyone who possesses the unpredictable 256-bit link token
can download the image. There is no public listing or public static directory.

## Lifetime and deletion

Successful upload starts a fixed **48-hour** lifetime. At the exact expiry time,
GET and HEAD refuse access even if cleanup has not yet run. Successful retries
and refreshed links never extend this deadline. Active downloads are terminated
when their deadline is reached. Responses disable caching and indexing.

The server sweeps expired files on startup and every 60 seconds, up to 100
records per sweep. Metadata remains with `file_deleted_at` set; token hashes are
cleared. Jobs, computation quotes/receipts and credit ledger entries do not expire.
The owner's status endpoint continues to return history with `image_available: false`.
Under normal load, physical deletion follows expiry within
one minute; a backlog, database outage, filesystem error or stopped server delays
physical deletion. It retries after failures and on restart. Pending reservations
expire after one hour. Abandoned temporary upload files are removed after two
hours. Database locks serialize finalization and cleanup across processes.

Expiry cannot remove a copy someone already downloaded or a copy in an external
backup. Exclude the media volume from long-lived backups if strict temporary
storage is required. The contributor's source image is preserved after upload;
this retention policy applies to the server copy.

## Deployment

1. `npm start` applies the bundled media migration before starting the web server
   when media is enabled. Set `MUNDUSX_DATABASE_URL` to the direct native PostgreSQL
   connection (Railway: `${{Postgres.DATABASE_URL}}`). The bundled SQL matches
   `db/migrations/0037_media_artifacts.sql` and `0038_media_compute_records.sql`, is idempotent, and uses a transaction
   lock. The runtime role must have access to the new table.
2. Mount persistent disk on the **web server** and set `MUNDUSX_MEDIA_DIR` to an
   absolute private path, for example `/var/lib/mundusx/media`. Do not place it
   under `public` or configure a reverse-proxy static alias for it.
3. Use the existing `MUNDUSX_DATABASE_POOL_URL` / auth database configuration.
   No additional storage credentials or signing secret are needed: only token
   hashes are persisted in PostgreSQL.
4. Route `/api/media/artifacts` and `/media/` to the web server over HTTPS.
   Allow PNG PUT bodies up to 32 MiB and a 120-second upload timeout. Do not cache
   these routes. Redact `token` query parameters and Authorization headers in
   proxy/access/analytics logs. Never log upload tickets or download links.
5. Run one web replica for a local volume; multiple replicas require the same
   shared filesystem. The directory and files are created with modes 0700/0600.

Without `MUNDUSX_MEDIA_DIR`, media routes return 503 and other services continue
unchanged. Missing migration/storage is an error, never a fallback to public
files or anonymous metadata.

## HTTP flow

`POST /api/media/artifacts` uses the current signed-in web session and the normal
CSRF header. This protects upload allocation; recipients need no account.
The request is the metadata of an already generated image:

```json
{"sha256":"<64 lowercase hexadecimal characters>","byte_size":849135,"width":1024,"height":1024,"content_type":"image/png"}
```

The response contains `artifact_id`, `download_path`, `preview_path`, and an
`upload_ticket`. Return the download/preview paths to the requester. Give only
the upload ticket to the contributor. Paths are relative to this web origin;
links return 404 until a valid upload is finalized.

The contributor sends `PUT /api/media/artifacts/{artifact_id}/content`, with
`Authorization: Bearer <upload_token>`, `Content-Type: image/png`, exact
`Content-Length`, and the raw PNG. No operator or account credential is needed.
The server checks the token, expected bytes/hash, PNG CRCs, decoded dimensions,
pixel format and bounded decompression. It writes atomically before recording
`ready` and returns an upload receipt containing the expiry timestamp.

The CLI implements this as:

```sh
opengpu media upload --file result.png --ticket upload-ticket.json --server https://your-web-host
```

The ticket file may contain the `upload_ticket` object or the whole reservation
response. It is a secret. The CLI does not follow redirects, rejects non-HTTPS
remote origins, validates the local file against the ticket, checks the receipt,
and preserves the local file on success and failure.

`GET /api/media/artifacts/{id}` returns status to the owning user. The owning user
may POST to `/api/media/artifacts/{id}/link` with CSRF protection to replace a
lost/leaked download link; this invalidates the old link without extending the
48-hour deadline. `GET` or `HEAD /media/{id}/image.png?token=...` needs only the
link. `inline=1` gives an image preview; otherwise it downloads an attachment.

Limits: PNG only, 32 MiB per file, at most 4096x4096 pixels, four concurrent
uploads per process, 64 unexpired reservations/results and 256 MiB per user.
The service refuses new reservations when less than 512 MiB plus the requested
size remains on the volume. SVG, video and arbitrary file downloads are rejected.

## Computation and credits

The initial versioned rate (`image-compute-v1`) is **4 compute credits and 4
contributor reward credits** for one `qwen-image-fp8-1024-v1` output: original
Qwen-Image FP8, 1024×1024, 30 steps. Calibration is provisional, based on one
216,337 ms GX10 generation: `ceil(216337 / 60000) = 4`. This is a chosen reference
compute-minute credit rate, not a cash price or a measured equivalence to LLM
text credits. Slower hardware, runtime overhead, waiting, upload, retries and
contribution percentage never inflate the reward. Actual generation time is
kept as telemetry. Higher resolutions, editing and video remain unpriced and
are rejected; benchmark and version those presets before enabling them.

`GET /api/media/quote?profile_id=qwen-image-fp8-1024-v1` returns the rate to a
signed-in user. `GET /api/media/computations/{job_id}` returns the owner's durable
quote and settlement, including after the image expires. No customer balance
is debited; the existing credit system is contributor rewards. Cash pricing
requires a separate policy.

Trusted dispatcher integration uses `Authorization: Bearer <operator token>`:

1. POST `/api/media/accounting/quote` with `job_id`, `owner_user_id`, `profile_id`
   before execution. The existing job must be queued and its classification
   must contain `operation: text_to_image` and the matching `media_profile_id`.
   The immutable quote is saved in native PostgreSQL, separate from the file.
2. After generation, create the owner's artifact reservation and POST
   `/api/media/accounting/bind` with `job_id`, `artifact_id`, `node_id` before
   uploading. Binding requires the assigned contributor, owner and dimensions
   to match. An ordinary user upload cannot create a computation or earn credits.
3. Upload and validate the PNG. Record successful job completion through the
   media dispatcher, then POST `/api/media/accounting/settle` with `job_id` and
   measured `generation_ms`. This requires both the completed assigned job and
   a ready, unexpired artifact. It atomically appends one `job_reward` to the
   existing `credits_ledger` and stores the settlement receipt. Retries return
   the same receipt, including after file deletion. Failed, cancelled or
   incomplete jobs earn nothing. An existing reward causes reconciliation to
   be required instead of issuing another reward.

Never give dispatcher credentials to contributors or browsers. The media
dispatcher must bypass the LLM text reward path and must not submit image jobs
to the legacy LLM scheduler. These endpoints do not create, schedule or execute
jobs. The legacy LLM formula is unchanged.

## Integration boundary and validation

This is the result transport layer for generated images. The distributed image
job scheduler and its user-facing generation flow are still separate work; this
change does not mark jobs complete, debit users, or enable image dispatch. When
that layer is connected, it must allocate the reservation for the recorded job
owner, deliver only the scoped upload ticket to the assigned worker, and return
the download link only to the requester. Never put worker tickets in shared job
listings. Image generation is not claimed complete until upload succeeds.

Tests exercise the actual PostgreSQL SQL using PGlite plus filesystem and HTTP:
ownership, no-login downloads, expiry at 48 hours, physical deletion, restart,
token rotation, scoped uploads, concurrent retries, database failure recovery,
PNG validation, quotas, fixed quotes, dispatcher authorization, exactly-once
settlement, rollback and preservation of jobs/credits after file expiry.
The contributor has separate upload-client tests.
Run `pnpm --filter @mundusx/chat test` and
`python -m unittest discover -s workers/media -p 'test_*.py'` in the contributor
repository. A deployment still needs a mounted volume, applied migration and
live upload/download verification.

Development verification on 2026-09-25: the real GX10 output (849135 bytes,
SHA-256 `64c98dea7a3ae44cf5c66e5287c6be3e9ae016c191fde9c11e8d88eb227a41b8`)
was uploaded by the compiled Windows CLI through a loopback web server using
the PostgreSQL test engine. The no-login download was byte-identical. Advancing
the test clock by 48 hours denied access and cleanup removed the file. The
subsequent accounting version retains the metadata, job and ledger history.
The updated ARM64 CLI was also built and installed on GX10, and its four upload
client tests passed there. The initial transport deployed via the `ehda` Git
branch to Railway's `chat` service; subsequent migrations run during startup.

## Video queue and downloads

`/video` is the signed-in video request page. Its 2/5/10-second presets use
Wan2.2-TI2V-5B at 1280×704, 24 fps, 20 steps (49/121/241 frames).
GX10 reference times measured at 65% contribution are 208508/535361/1212278 ms,
priced at 4/9/21 credits respectively. This is fixed reference work, not a
charge based on a worker's claimed runtime. There is still no customer balance
debit. One validated completion earns the corresponding contributor reward.

`POST /api/media/jobs` accepts `prompt`, `profile_id`, an optional `seed`, and
an `idempotency_key` UUID. Normal account authentication and CSRF apply.
`GET /api/media/jobs` and `/api/media/jobs/{id}` return only the owner's jobs.
At most four pending requests are allowed per account. Requests wait FIFO for
a compatible worker; each contributor has one media slot. Workers claim with
Ed25519 device signatures, timestamp bounds and single-use nonces. Only an
existing registered contributor whose policy allows work can claim jobs.
Workers heartbeat 180-second leases. Expired leases retry up to three attempts;
a stale lease cannot bind output or complete a job. Polling recovers leases after
server restart. No worker receives an operator token or a download link.

Queued/running/completed media rows use `media_` states in the existing jobs
table so the legacy LLM restore query cannot execute them. The dedicated queue,
immutable quote, artifact, and existing credit ledger keep durable history.
Completion requires a fully decoded MP4 matching its quoted preset. Settlement
is idempotent; the CLI persists a pending completion receipt to retry across a
restart. Failed jobs earn nothing. Signed worker endpoints live under
`/api/media/worker/{claim,heartbeat,reserve,complete,fail}`.

MP4 uploads allow up to 128 MiB. FFprobe checks codec, dimensions, exact frame
count, fps and duration; FFmpeg decodes the entire video with bounded execution.
Railpack installs FFmpeg through `apps/chat/railpack.json`. Missing validation
tools fail closed. Image routes and old PNG tickets retain their previous behavior.
Video links use `/media/{id}/video.mp4?token=...`; the same no-login 48-hour policy
and physical cleanup apply. Deletion never removes job, quote or credit records.

Contributors run `opengpu media --video setup --yes`, `opengpu media --video verify`,
then `opengpu media serve --server https://chat.mundusx.ai`. The updated node agent
also launches the media worker for selected video contribution, after normal
registration. Use `MUNDUSX_MEDIA_SERVER_URL` for a custom deployment. Local LLM
batches drain before managed ComfyUI launches and can resume after it stops.
