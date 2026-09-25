-- Accept 480p at 16 FPS while retaining every historical video format.
alter table public.media_artifacts drop constraint if exists media_artifacts_byte_size_check;
alter table public.media_artifacts add constraint media_artifacts_byte_size_check check (
  (content_type='image/png' and byte_size between 1 and 33554432 and frames is null and fps is null)
  or (content_type='video/mp4' and byte_size between 1 and 134217728
      and ((width=1280 and height=704 and frames in (49,121,241) and fps=24)
        or (((width=1280 and height=704) or (width=832 and height=480))
            and frames between 17 and 161 and (frames-1)%16=0 and fps=16))));
