import { z } from 'zod';

export function registerMediaTools(server, service, owner) {
  const wrap = action => async input => {
    try {
      const result = await action(input);
      const content = [{ type: 'text', text: JSON.stringify(result) }];
      if (result.download_url) content.push({ type: 'resource_link', uri: result.download_url,
        name: result.content_type === 'video/mp4' ? 'Generated video' : 'Generated image',
        mimeType: result.content_type, description: `Download available until ${result.expires_at}` });
      return { content, structuredContent: result };
    } catch (error) {
      const result = { error: error.message, status: error.statusCode || 500 };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
  };
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool('mundusx_media_profiles', {
    description: 'List image/video generation profiles, estimated compute credits, and file retention before creating media.',
    annotations: read,
  }, wrap(() => service.profiles()));
  for (const kind of ['image', 'video']) server.registerTool(`mundusx_generate_${kind}`, {
    description: `Queue ${kind} generation requested by the user. Returns a job ID immediately, not a finished URL. Reuse the same UUID idempotency_key for retries of this request. Poll mundusx_get_media_job after poll_after_seconds; only claim completion when state is completed, then call mundusx_get_media_result. Never invent a URL or progress percentage.`,
    inputSchema: z.object({ prompt: z.string().min(1).max(4000), idempotency_key: z.string().uuid(),
      seed: z.number().int().min(0).max(2147483647).optional(),
      ...(kind === 'image' ? { model: z.enum(['Qwen/Qwen-Image','Lykon/dreamshaper-8']).optional() } : {}),
      ...(kind === 'video' ? { duration_seconds: z.number().int().min(1).max(10).default(3) } : {}) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, wrap(input => service.submit(owner, { ...input, kind })));
  server.registerTool('mundusx_edit_image', {
    description:'Edit an owned reference PNG with Qwen Image Edit. Upload the PNG through POST /v1/media/reference first. Returns an asynchronous job; use the existing job/status/result tools.',
    inputSchema:z.object({prompt:z.string().min(1).max(4000),input_artifact_id:z.string().uuid(),idempotency_key:z.string().uuid(),seed:z.number().int().min(0).max(2147483647).optional()}),
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },wrap(input=>service.submit(owner,{...input,kind:'image',model:'Qwen/Qwen-Image-Edit-2509'})));
  server.registerTool('mundusx_get_media_job', {
    description: 'Check an owned media job. Queued/running means still waiting; respect poll_after_seconds. Completed means call mundusx_get_media_result for the download link. Failed means report the failure. If the client cannot continue polling, retain the job ID and check on the next user request.',
    inputSchema: z.object({ job_id: z.string().uuid() }), annotations: read,
  }, wrap(({ job_id }) => service.status(owner, job_id)));
  server.registerTool('mundusx_get_media_result', {
    description: 'Get a download and preview URL for a completed owned media job. Links expire after 48 hours from artifact creation; jobs and credit records remain. This rotates the previous link: fetch once when delivering the result, not on every status poll.',
    inputSchema: z.object({ job_id: z.string().uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, wrap(({ job_id }) => service.result(owner, job_id)));
}
