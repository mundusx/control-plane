-- Cross-device Chat conversation discovery and presentation metadata.

alter table public.user_chat_conversations
  add column if not exists title text,
  add column if not exists pinned boolean not null default false,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists last_message_at timestamptz not null default now();

create index if not exists user_chat_conversations_recent_idx
  on public.user_chat_conversations (user_id, pinned desc, last_message_at desc, conversation_id);

with conversation_summaries as (
  select
    owned.conversation_id,
    (array_agg(message.content order by message.created_at asc, message.id asc)
      filter (where message.role = 'user'))[1] as first_user_message,
    max(message.created_at) as latest_message_at
  from public.user_chat_conversations owned
  left join public.chat_messages message on message.conversation_id = owned.conversation_id
  group by owned.conversation_id
)
update public.user_chat_conversations owned set
  title = coalesce(
    owned.title,
    nullif(left(btrim(regexp_replace(summary.first_user_message, '\s+', ' ', 'g')), 72), '')
  ),
  last_message_at = coalesce(summary.latest_message_at, owned.last_message_at),
  updated_at = greatest(owned.updated_at, coalesce(summary.latest_message_at, owned.updated_at))
from conversation_summaries summary
where summary.conversation_id = owned.conversation_id;
