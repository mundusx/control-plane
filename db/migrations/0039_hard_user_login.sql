create table if not exists public.hard_user_login_limits (
  bucket text primary key,
  started_at timestamptz not null,
  attempts integer not null check (attempts > 0)
);
revoke all on public.hard_user_login_limits from public;
