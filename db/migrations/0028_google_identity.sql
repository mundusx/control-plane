-- Allow Google OpenID Connect identities and one-use OAuth challenges.

alter table public.user_identities
  drop constraint if exists user_identities_provider_check;

alter table public.user_identities
  add constraint user_identities_provider_check
  check (provider in ('github', 'google', 'email'));

alter table public.auth_challenges
  drop constraint if exists auth_challenges_challenge_type_check;

alter table public.auth_challenges
  add constraint auth_challenges_challenge_type_check
  check (challenge_type in ('github_oauth', 'google_oauth', 'email_magic_link'));
