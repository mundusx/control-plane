-- Image metadata lives in PostgreSQL; bytes live on a private persistent volume.
create table if not exists public.media_artifacts (
  artifact_id uuid primary key,
  owner_user_id uuid references public.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'ready')),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size integer not null check (byte_size between 1 and 33554432),
  width integer not null check (width between 1 and 4096),
  height integer not null check (height between 1 and 4096),
  upload_token_hash text not null check (upload_token_hash ~ '^[0-9a-f]{64}$'),
  download_token_hash text not null check (download_token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  upload_expires_at timestamptz not null,
  ready_at timestamptz,
  expires_at timestamptz not null,
  check ((status = 'pending' and ready_at is null) or (status = 'ready' and ready_at is not null))
);
create index if not exists media_artifacts_expiry_idx on public.media_artifacts(expires_at);
create index if not exists media_artifacts_owner_idx on public.media_artifacts(owner_user_id, created_at);
revoke all on public.media_artifacts from public;
