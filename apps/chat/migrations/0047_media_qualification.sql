CREATE TABLE IF NOT EXISTS public.media_qualification_probes (
  job_id uuid PRIMARY KEY,
  node_id text NOT NULL REFERENCES public.devices(node_id),
  profile_id text NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','passed','failed')),
  lease_hash text,
  lease_until timestamptz,
  artifact_id uuid UNIQUE,
  upload_hash text,
  metadata jsonb,
  uploaded boolean NOT NULL DEFAULT false,
  generation_ms bigint,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(node_id,profile_id,fingerprint)
);
CREATE INDEX IF NOT EXISTS media_qualification_active_node_idx
  ON public.media_qualification_probes(node_id) WHERE state='running';
