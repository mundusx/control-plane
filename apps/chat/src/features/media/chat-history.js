import { httpError } from '../../shared/http-error.js';

export async function persistMediaChatTurn(store, owner, conversationId, job, intent) {
  return store.transaction(async db => {
    // Serialize retries from this owner; retain one user/assistant pair per media job.
    await db.query('select id from public.users where id=$1 for update', [owner]);
    const existing = (await db.query('select conversation_id from public.chat_messages where job_id=$1', [job.job_id])).rows[0];
    if (existing) {
      if (existing.conversation_id !== conversationId) throw httpError(409, 'This media request already belongs to another conversation');
      return;
    }
    await db.query('insert into public.chat_conversations(conversation_id) values($1) on conflict(conversation_id) do nothing', [conversationId]);
    await db.query("insert into public.chat_messages(conversation_id,role,content,metadata) values($1,'user',$2,'{}')", [conversationId,intent.prompt]);
    await db.query("insert into public.chat_messages(conversation_id,role,content,job_id,metadata) values($1,'assistant',$2,$3,$4)",
      [conversationId,intent.kind === 'video' ? 'Video generation' : 'Image generation',job.job_id,{media_job:{...intent,job_id:job.job_id}}]);
    await db.query('update public.chat_conversations set last_message_at=now(),message_count=(select count(*) from public.chat_messages where conversation_id=$1) where conversation_id=$1', [conversationId]);
  });
}
