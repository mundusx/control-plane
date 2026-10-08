-- Keep historical 5B artifacts valid while admitting the 14B 16 FPS workflow.
alter table public.media_artifacts drop constraint if exists media_artifacts_byte_size_check;
alter table public.media_artifacts add constraint media_artifacts_byte_size_check check (
  (content_type='image/png' and byte_size between 1 and 33554432 and frames is null and fps is null)
  or (content_type='video/mp4' and byte_size between 1 and 134217728 and width=1280 and height=704
      and ((frames in (49,121,241) and fps=24) or (frames in (33,81,161) and fps=16))));
