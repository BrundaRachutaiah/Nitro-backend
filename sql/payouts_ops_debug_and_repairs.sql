-- ================================================================
-- NITRO — Ops: Payout Debug + Safe Repairs (Repeat Cycles)
-- Run in Supabase SQL Editor
--
-- This file contains SAFE, non-destructive queries to debug payouts and
-- a few guarded repair scripts for common issues.
--
-- Replace placeholders:
--   <participant_id>  -> a UUID from public.profiles.id
--   <batch_id>        -> a UUID from public.payout_batches.id
--   <since_ts>        -> a timestamptz like '2026-03-12 00:00:00+00'
-- ================================================================

-- ------------------------------------------------
-- 0) Identify ids
-- ------------------------------------------------
-- Latest batches
SELECT id, status, total_amount, created_at
FROM public.payout_batches
ORDER BY created_at DESC
LIMIT 10;

-- Find participant id by email
-- SELECT id, full_name, email FROM public.profiles WHERE lower(email) = lower('someone@example.com');

-- ------------------------------------------------
-- 1) Payout state for a participant
-- ------------------------------------------------
-- Replace <participant_id>
SELECT id, user_id, participant_id, project_id, product_id, status, payout_batch_id, amount, created_at, paid_at
FROM public.payouts
WHERE participant_id = '<participant_id>'
ORDER BY created_at DESC
LIMIT 100;

-- ------------------------------------------------
-- 2) Payouts linked to a batch
-- ------------------------------------------------
-- Replace <batch_id>
SELECT id, participant_id, project_id, product_id, status, payout_batch_id, amount, created_at, paid_at
FROM public.payouts
WHERE payout_batch_id = '<batch_id>'
ORDER BY created_at DESC;

-- Batch count quick check
SELECT COUNT(*) AS payouts_in_batch
FROM public.payouts
WHERE payout_batch_id = '<batch_id>';

-- ------------------------------------------------
-- 3) Applications for a participant (cycle visibility)
-- ------------------------------------------------
-- Replace <participant_id>
SELECT id, participant_id, project_id, product_id, status, created_at, reviewed_at
FROM public.project_applications
WHERE participant_id = '<participant_id>'
ORDER BY COALESCE(reviewed_at, created_at) DESC, created_at DESC
LIMIT 200;

-- ------------------------------------------------
-- REPAIR A: Backfill ELIGIBLE payouts for admin-approved applications
-- ------------------------------------------------
-- Use when /admin/payouts/eligible is empty but applications are APPROVED.
-- Replace <participant_id> and <since_ts> (optional).
INSERT INTO public.payouts (user_id, participant_id, project_id, product_id, amount, status, created_at)
SELECT
  pa.participant_id AS user_id,
  pa.participant_id,
  pa.project_id,
  pa.product_id,
  COALESCE(pp.product_value, 0) AS amount,
  'ELIGIBLE',
  now()
FROM public.project_applications pa
JOIN public.project_products pp ON pp.id = pa.product_id
WHERE pa.participant_id = '<participant_id>'
  AND pa.product_id IS NOT NULL
  AND pa.status IN ('APPROVED','PURCHASED','COMPLETED')
  AND COALESCE(pa.reviewed_at, pa.created_at) >= COALESCE(NULLIF('<since_ts>', '' )::timestamptz, '-infinity'::timestamptz)
  AND NOT EXISTS (
    SELECT 1
    FROM public.payouts p
    WHERE p.participant_id = pa.participant_id
      AND p.project_id = pa.project_id
      AND p.product_id = pa.product_id
      AND p.status IN ('ELIGIBLE','IN_BATCH','EXPORTED','PAID')
      AND p.created_at >= COALESCE(NULLIF('<since_ts>', '' )::timestamptz, '-infinity'::timestamptz)
  );

-- ------------------------------------------------
-- REPAIR B: Mark a batch PAID (and stamp paid_at) for all linked payouts
-- ------------------------------------------------
-- Use when batch shows PAID but payouts are not updated, or vice versa.
-- Replace <batch_id>
UPDATE public.payouts
SET status = 'PAID',
    paid_at = COALESCE(paid_at, now())
WHERE payout_batch_id = '<batch_id>'
  AND status <> 'PAID';

UPDATE public.payout_batches
SET status = 'PAID',
    paid_at = COALESCE(paid_at, now())
WHERE id = '<batch_id>';

-- ------------------------------------------------
-- REPAIR C: Ensure batch total_amount matches payouts
-- ------------------------------------------------
UPDATE public.payout_batches b
SET total_amount = COALESCE((
  SELECT SUM(p.amount)
  FROM public.payouts p
  WHERE p.payout_batch_id = b.id
), 0)
WHERE b.id = '<batch_id>';
