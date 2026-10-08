-- Durable settlements remain countable after the downloadable artifact expires.
with completed as (
    select quote->>'operation' as operation, generation_ms,
           (quote->>'width')::numeric * (quote->>'height')::numeric *
               (quote->>'steps')::numeric / 1000000 as megapixel_steps,
           (quote->>'frames')::numeric * (quote->>'steps')::numeric as frame_steps
    from public.media_compute_records
    where status = 'settled'
      and quote->>'operation' in ('text_to_image', 'text_to_video', 'image_to_video')
)
select json_build_object(
    'available', true,
    'completed_generations', count(*)::text,
    'completed_images', (count(*) filter (where operation = 'text_to_image'))::text,
    'completed_videos', (count(*) filter (where operation <> 'text_to_image'))::text,
    'generation_ms', coalesce(sum(generation_ms), 0)::text,
    'average_image_generation_ms', (avg(generation_ms) filter (where operation = 'text_to_image'))::float8,
    'average_video_generation_ms', (avg(generation_ms) filter (where operation <> 'text_to_image'))::float8,
    'image_megapixel_steps', coalesce(sum(megapixel_steps) filter (where operation = 'text_to_image'), 0)::text,
    'video_frame_steps', coalesce(sum(frame_steps) filter (where operation <> 'text_to_image'), 0)::text,
    'scope', 'settled media generations; queued, failed and unsettled attempts excluded',
    'token_equivalents', null
)::text from completed
