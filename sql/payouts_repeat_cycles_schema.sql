-- ================================================================
-- NITRO — Schema Support For Repeat Application Cycles + Per-Product Payouts
-- Run in Supabase SQL Editor (safe / idempotent where possible)
--
-- Purpose
-- - Allow participants to apply for the SAME product again in a later cycle
-- - Track invoices/reviews per product (not per allocation only)
-- - Ensure payouts can be created per (participant, project, product)
--
-- Notes
-- - This file intentionally avoids participant-specific DELETE/UPDATE fixes.
-- - Data repair scripts belong in a separate ops file.
-- ================================================================

NOTIFY pgrst, 'reload schema';

-- Enable UUID generator (safe if already enabled)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ================================================================
-- 1) project_products
-- ================================================================

ALTER TABLE public.project_products
  ADD COLUMN IF NOT EXISTS image_url TEXT;

-- product_value is the authoritative catalogue price used for payouts
ALTER TABLE public.project_products
  ADD COLUMN IF NOT EXISTS product_value NUMERIC DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_project_products_project_id
  ON public.project_products(project_id);

-- ================================================================
-- 2) project_applications
-- ================================================================

ALTER TABLE public.project_applications
  ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES public.project_products(id),
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS eligibility_notes TEXT,
  ADD COLUMN IF NOT EXISTS allocated_budget NUMERIC,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

UPDATE public.project_applications
SET updated_at = COALESCE(updated_at, created_at, now())
WHERE updated_at IS NULL;

-- Repeat cycles: DO NOT keep a UNIQUE constraint on (participant_id, project_id, product_id).
-- Older databases may have either a UNIQUE INDEX or a named UNIQUE CONSTRAINT.
DROP INDEX IF EXISTS public.uq_app_participant_project_product;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'project_applications'
      AND con.contype = 'u'
      AND pg_get_constraintdef(con.oid) ILIKE '%participant_id%'
      AND pg_get_constraintdef(con.oid) ILIKE '%project_id%'
      AND pg_get_constraintdef(con.oid) ILIKE '%product_id%'
  LOOP
    EXECUTE format('ALTER TABLE public.project_applications DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

-- Performance indexes (repeat-cycle friendly)
CREATE INDEX IF NOT EXISTS idx_project_applications_participant_project_product_created_at
  ON public.project_applications (participant_id, project_id, product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_applications_status_created_at
  ON public.project_applications (status, created_at DESC);

-- ================================================================
-- 3) purchase_proofs (per-product invoices)
-- ================================================================

ALTER TABLE public.purchase_proofs
  ADD COLUMN IF NOT EXISTS product_id UUID
  REFERENCES public.project_products(id)
  ON DELETE SET NULL;

-- Replace old constraint (allocation_id, participant_id) with per-product
ALTER TABLE public.purchase_proofs
  DROP CONSTRAINT IF EXISTS purchase_proofs_allocation_id_participant_id_key;

ALTER TABLE public.purchase_proofs
  ADD CONSTRAINT purchase_proofs_alloc_participant_product_key
  UNIQUE NULLS NOT DISTINCT (allocation_id, participant_id, product_id);

-- ================================================================
-- 4) participant_reviews (per-product reviews)
-- ================================================================

ALTER TABLE public.participant_reviews
  ADD COLUMN IF NOT EXISTS product_id UUID
  REFERENCES public.project_products(id)
  ON DELETE SET NULL;

ALTER TABLE public.participant_reviews
  DROP CONSTRAINT IF EXISTS participant_reviews_allocation_id_participant_id_key;

ALTER TABLE public.participant_reviews
  ADD CONSTRAINT participant_reviews_alloc_participant_product_key
  UNIQUE NULLS NOT DISTINCT (allocation_id, participant_id, product_id);

-- ================================================================
-- 5) payouts + payout_batches (timestamps + linking)
-- ================================================================

ALTER TABLE public.payouts
  ADD COLUMN IF NOT EXISTS participant_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES public.project_products(id),
  ADD COLUMN IF NOT EXISTS payout_batch_id UUID REFERENCES public.payout_batches(id),
  ADD COLUMN IF NOT EXISTS purchase_proof_id UUID REFERENCES public.purchase_proofs(id),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

ALTER TABLE public.payout_batches
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

NOTIFY pgrst, 'reload schema';

