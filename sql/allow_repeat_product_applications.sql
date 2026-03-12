-- Allow a participant to apply for the same product multiple times across cycles.
-- This keeps old APPROVED/COMPLETED rows intact and lets a new PENDING row be inserted.

ALTER TABLE public.project_applications
ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

UPDATE public.project_applications
SET updated_at = COALESCE(updated_at, created_at, now())
WHERE updated_at IS NULL;

DO $$
DECLARE
  constraint_row record;
  index_row record;
BEGIN
  -- Drop unique constraints on the same participant/project/product combination.
  FOR constraint_row IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel
      ON rel.oid = con.conrelid
    JOIN pg_namespace nsp
      ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'project_applications'
      AND con.contype = 'u'
      AND pg_get_constraintdef(con.oid) ILIKE '%participant_id%'
      AND pg_get_constraintdef(con.oid) ILIKE '%project_id%'
      AND pg_get_constraintdef(con.oid) ILIKE '%product_id%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.project_applications DROP CONSTRAINT IF EXISTS %I',
      constraint_row.conname
    );
  END LOOP;

  -- Drop unique indexes that enforce the same rule.
  FOR index_row IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'project_applications'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND indexdef ILIKE '%participant_id%'
      AND indexdef ILIKE '%project_id%'
      AND indexdef ILIKE '%product_id%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', index_row.indexname);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_project_applications_participant_project_product_created_at
  ON public.project_applications (participant_id, project_id, product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_applications_status_created_at
  ON public.project_applications (status, created_at DESC);
