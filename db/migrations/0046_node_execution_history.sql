ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS execution_history_json jsonb;

-- Recover available execution counts once from durable jobs. Existing snapshots
-- remain authoritative; absent history stays unrated rather than invented.
UPDATE public.devices AS device
SET execution_history_json = jsonb_build_object(
  'revision', 0, 'score', 50,
  'completed_jobs', history.completed, 'failed_jobs', history.failed,
  'accepted_results', history.completed, 'rejected_results', history.failed,
  'consecutive_failures', 0, 'total_latency_ms', 0,
  'last_success_at', history.last_success, 'last_failure_at', history.last_failure,
  'last_failure_reason', null,
  'qualification_required', false
)
FROM (
  SELECT assigned_node_id,
    count(*) FILTER (WHERE status = 'completed') AS completed,
    count(*) FILTER (WHERE status = 'failed') AS failed,
    (max(completed_at_epoch) FILTER (WHERE status = 'completed'))::text AS last_success,
    (max(completed_at_epoch) FILTER (WHERE status = 'failed'))::text AS last_failure
  FROM public.jobs
  WHERE assigned_node_id IS NOT NULL
    AND status IN ('completed', 'failed')
    AND mode IS DISTINCT FROM 'contributor_qualification_v1'
  GROUP BY assigned_node_id
) AS history
WHERE device.node_id = history.assigned_node_id
  AND device.execution_history_json IS NULL;
