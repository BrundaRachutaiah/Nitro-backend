-- NITRO — One-time data fix for missing payouts + wrong payout amounts
-- Participant: 478186c9-8da2-4214-9f6f-07b9a5e982a8 (BRUNDA)
--
-- Safe notes:
-- - Do NOT dedupe only by (participant_id, project_id). Multi-product payouts share the same project.
-- - If you need dedupe, use (participant_id, project_id, product_id, status) and keep the newest/oldest per key.
-- - `user_id` column may not exist in your `payouts` table. Two insert variants are included below.

NOTIFY pgrst, 'reload schema';

-- 0) If your payouts table has user_id (NOT NULL in many schemas), backfill it for existing rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payouts'
      AND column_name = 'user_id'
  ) THEN
    EXECUTE $SQL$
      UPDATE public.payouts
      SET user_id = participant_id
      WHERE user_id IS NULL
        AND participant_id IS NOT NULL
    $SQL$;
  END IF;
END $$;

-- 1) Preview: payouts vs catalogue product_value
SELECT
  p.id,
  p.participant_id,
  p.project_id,
  p.product_id,
  pp.name AS product_name,
  pp.product_value AS correct_amount,
  p.amount AS stored_amount,
  p.status,
  p.created_at
FROM public.payouts p
JOIN public.project_products pp ON pp.id = p.product_id
WHERE p.participant_id = '478186c9-8da2-4214-9f6f-07b9a5e982a8'
ORDER BY p.created_at ASC;

-- 2) Fix wrong amount: always align to project_products.product_value
UPDATE public.payouts p
SET amount = pp.product_value
FROM public.project_products pp
WHERE pp.id = p.product_id
  AND p.amount IS DISTINCT FROM pp.product_value;

-- 3) Insert missing ELIGIBLE payout rows
--    Inserts only if both proof + review are approved and no active payout exists yet.
--    Supports schemas with and without NOT-NULL `user_id`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payouts'
      AND column_name = 'user_id'
  ) THEN
    EXECUTE $SQL$
      INSERT INTO public.payouts (participant_id, user_id, project_id, product_id, amount, status, created_at)
      SELECT DISTINCT ON (pa.participant_id, pa.project_id, pa.product_id)
        pa.participant_id,
        pa.participant_id AS user_id,
        pa.project_id,
        pa.product_id,
        pp.product_value AS amount,
        'ELIGIBLE' AS status,
        NOW() AS created_at
      FROM public.project_applications pa
      JOIN public.project_products pp ON pp.id = pa.product_id
      JOIN public.purchase_proofs pf
        ON pf.participant_id = pa.participant_id
       AND pf.product_id = pa.product_id
       AND pf.status = 'APPROVED'
      JOIN public.participant_reviews pr
        ON pr.participant_id = pa.participant_id
       AND pr.product_id = pa.product_id
       AND pr.status = 'APPROVED'
      WHERE pa.participant_id = '478186c9-8da2-4214-9f6f-07b9a5e982a8'
        AND pa.status IN ('APPROVED', 'PURCHASED', 'COMPLETED')
        AND pp.product_value > 0
        AND NOT EXISTS (
          SELECT 1
          FROM public.payouts po
          WHERE po.participant_id = pa.participant_id
            AND po.project_id = pa.project_id
            AND po.product_id = pa.product_id
            AND po.status IN ('ELIGIBLE', 'IN_BATCH', 'EXPORTED', 'PAID')
        )
      ORDER BY pa.participant_id, pa.project_id, pa.product_id, COALESCE(pa.reviewed_at, pa.created_at) DESC
    $SQL$;
  ELSE
    EXECUTE $SQL$
      INSERT INTO public.payouts (participant_id, project_id, product_id, amount, status, created_at)
      SELECT DISTINCT ON (pa.participant_id, pa.project_id, pa.product_id)
        pa.participant_id,
        pa.project_id,
        pa.product_id,
        pp.product_value AS amount,
        'ELIGIBLE' AS status,
        NOW() AS created_at
      FROM public.project_applications pa
      JOIN public.project_products pp ON pp.id = pa.product_id
      JOIN public.purchase_proofs pf
        ON pf.participant_id = pa.participant_id
       AND pf.product_id = pa.product_id
       AND pf.status = 'APPROVED'
      JOIN public.participant_reviews pr
        ON pr.participant_id = pa.participant_id
       AND pr.product_id = pa.product_id
       AND pr.status = 'APPROVED'
      WHERE pa.participant_id = '478186c9-8da2-4214-9f6f-07b9a5e982a8'
        AND pa.status IN ('APPROVED', 'PURCHASED', 'COMPLETED')
        AND pp.product_value > 0
        AND NOT EXISTS (
          SELECT 1
          FROM public.payouts po
          WHERE po.participant_id = pa.participant_id
            AND po.project_id = pa.project_id
            AND po.product_id = pa.product_id
            AND po.status IN ('ELIGIBLE', 'IN_BATCH', 'EXPORTED', 'PAID')
        )
      ORDER BY pa.participant_id, pa.project_id, pa.product_id, COALESCE(pa.reviewed_at, pa.created_at) DESC
    $SQL$;
  END IF;
END $$;

-- 4) Verify: expected 2–3 rows for Brunda (depending on how many products have both artifacts approved)
SELECT
  prf.full_name,
  pp.name AS product_name,
  p.amount,
  p.status,
  p.created_at
FROM public.payouts p
LEFT JOIN public.profiles prf ON prf.id = p.participant_id
LEFT JOIN public.project_products pp ON pp.id = p.product_id
WHERE p.participant_id = '478186c9-8da2-4214-9f6f-07b9a5e982a8'
ORDER BY p.created_at ASC;
