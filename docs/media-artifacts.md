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

The server sweeps expired rows/files on startup and every 60 seconds, up to 100
records per sweep. Under normal load, physical deletion follows expiry within
one minute; a backlog, database outage, filesystem error or stopped server delays
physical deletion. It retries after failures and on restart. Pending reservations
expire after one hour. Abandoned temporary upload files are removed after two
hours. Database locks serialize finalization and cleanup across processes.

Expiry cannot remove a copy someone already downloaded or a copy in an external
backup. Exclude the media volume from long-lived backups if strict temporary
storage is required. The contributor's source image is preserved after upload;
this retention policy applies to the server copy.

## Deployment

1. Apply `db/migrations/0037_media_artifacts.sql` through the existing native
   PostgreSQL migration process. The runtime database role needs access to the
   new table, as with the other application tables.
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

## Integration boundary and validation

This is the result transport layer for generated images. The distributed image
job scheduler and its user-facing generation flow are still separate work; this
change does not mark jobs complete, charge users, or enable image dispatch. When
that layer is connected, it must allocate the reservation for the recorded job
owner, deliver only the scoped upload ticket to the assigned worker, and return
the download link only to the requester. Never put worker tickets in shared job
listings. Image generation is not claimed complete until upload succeeds.

Tests exercise the actual PostgreSQL SQL using PGlite plus filesystem and HTTP:
ownership, no-login downloads, expiry at 48 hours, physical deletion, restart,
token rotation, scoped uploads, concurrent retries, database failure recovery,
PNG validation and quotas. The contributor has separate upload-client tests.
Run `pnpm --filter @mundusx/chat test` and
`python -m unittest discover -s workers/media -p 'test_*.py'` in the contributor
repository. A deployment still needs a mounted volume, applied migration and
live upload/download verification.

Development verification on 2026-09-25: the real GX10 output (849135 bytes,
SHA-256 `64c98dea7a3ae44cf5c66e5287c6be3e9ae016c191fde9c11e8d88eb227a41b8`)
was uploaded by the compiled Windows CLI through a loopback web server using
the PostgreSQL test engine. The no-login download was byte-identical. Advancing
the test clock by 48 hours denied access and cleanup removed the file and row.
The updated ARM64 CLI was also built and installed on GX10, and its four upload
client tests passed there. No public web-server deployment or live database
migration has been performed by this change yet.
