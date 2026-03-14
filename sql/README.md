# Nitro SQL

This folder contains Supabase SQL editor scripts used to evolve the schema and debug/repair data.

## Files

- `allow_repeat_product_applications.sql`
  - Legacy patch: removes the unique constraint/index that blocked re-applying to the same product.

- `payouts_repeat_cycles_schema.sql`
  - Recommended schema migration to support repeat application cycles + per-product proofs/reviews + payout timestamps.

- `payouts_ops_debug_and_repairs.sql`
  - Operational queries to debug payout/batch state and safe repair scripts (requires you to replace placeholders).

