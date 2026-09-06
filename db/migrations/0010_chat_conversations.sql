-- MundusX migration 0010: conversation memory for chat (client-generated conversation ids).

create table if not exists public.chat_conversations (
  conversation_id uuid primary key,
  title text,
  last_message_at timestamptz,
  message_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.chat_conversations(conversation_id) on delete cascade,
  role text not null,
  content text not null,
  job_id text references public.jobs(job_id),
  tool text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

drop trigger if exists chat_conversations_set_updated_at on public.chat_conversations;
create trigger chat_conversations_set_updated_at
before update on public.chat_conversations
for each row execute function public.set_updated_at();

create index if not exists chat_messages_conversation_id_created_at_idx
  on public.chat_messages(conversation_id, created_at asc, id asc);

create index if not exists chat_messages_job_id_idx
  on public.chat_messages(job_id);

-- idempotency: repeated polls of a completed job must not double-insert the assistant turn
create unique index if not exists chat_messages_job_id_unique_idx
  on public.chat_messages(job_id) where job_id is not null;
