-- Individual heartbeat history is no longer persisted. Live scheduling state remains
-- in memory and public.devices holds the bounded durable checkpoint for each node.
-- Keep the empty table temporarily so rollback to the preceding binary stays possible.

truncate table public.heartbeats restart identity;
