# Public media-only admission rollout

## Deployment mapping verified 2026-10-05

The website is `mundusx.ai`. Registration/admission is `control.mundusx.ai`;
chat, user media APIs and signed worker transport are `chat.mundusx.ai`.

Railway project `mundusx`, environment named `prod`, hosts both public services.
The control-plane process currently labels its application environment `uat`;
this label is not the Railway environment name. Do not deploy to the empty
Railway `uat` environment based solely on the health response.

| Service | Repository | Deployment branch | Previous commit |
| --- | --- | --- | --- |
| control-plane | mundusx/control-plane | benz-ehda | 462b28ea4790340e0b7486beeb57562c3d4763b9 |
| chat | mundusx/control-plane | ehda | b925964347003cb0643e8d61e2a2edc8f258dcf7 |

This change ports only media health, admission, LLM exclusion and their tests to
the actual deployed control-plane branch. Companion chat/API changes are in
control-plane PR #733; contributor changes are in mundusx PR #323. Deploy these
together. Merging the ehda PR alone cannot change benz-ehda admission.

## Rollout sequence

1. Deploy this admission revision to the existing control-plane service. Check
   `/health` fingerprint and verify existing LLM workers still qualify.
2. Deploy PR #733's chat revision to the existing chat service. Retain its `/media`
   persistent volume and existing media migrations. User-owned token authentication,
   ownership, signed leases, and settlement checks remain enforced.
3. Update both CLI and node agent on the selected media GX10. Retain its existing
   identity and model cache, choose only image/video/image-to-video workloads, and
   free its memory from an external vLLM workload before verification.
4. Verify image, T2V and fast I2V profiles for the durations to advertise. Verification
   creates real media. Start the contributor; confirm live health reports runtime
   mode `media`, exact profiles and one execution slot, with no LLM model advertisement.
5. Submit neutral image, T2V and PNG-reference I2V requests through authenticated chat
   or media APIs. Confirm upload, owner retrieval and exactly-once settlement.

Existing model policy is currently unenforced. If it becomes enforced, allow the
specific selected Qwen/Wan model identities rather than disabling admission gates.

Keep previous service deployment IDs and backed-up GX10 binaries/configuration for
rollback. Revert the contributor first if needed; no new database migration is
introduced by this admission patch. Never delete the persistent media volume.

During deployment, the existing PgBouncer route stalled large startup job-history
responses while small chat queries continued working. A read-only 1 MiB probe
timed out through the pool but completed in about 1.4 seconds through the direct
database connection. Startup hydration therefore uses the configured direct URL;
ordinary runtime reads/writes continue using the pooled URL. Pool-only/local
configurations retain their existing startup route. No historical records are
deleted or truncated by this fix.

The public website and novusmundus2025 repositories are outside this rollout.
