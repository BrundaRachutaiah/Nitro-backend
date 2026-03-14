const supabase = require('../config/supabaseClient');
const { calculatePayoutBreakdown } = require('../utils/payout.utils');
const { sendEmail } = require('../services/email.service');
const { payoutPaidEmail } = require('../services/email.templates');

const isMissingSchemaObjectError = (error) => {
  const text = String(error?.message || '').toLowerCase();
  return (
    text.includes('does not exist')
    || text.includes('could not find')
    || text.includes('schema cache')
    || text.includes('column')
    || text.includes('relation')
    || text.includes('table')
  );
};

/**
 * ✅ Create ELIGIBLE payout ONLY when BOTH invoice + review are APPROVED
 * This is the KEY FIX — payouts now only appear after 2nd approval
 */
const createPayoutIfBothApproved = async ({
  participantId,
  projectId,
  productId
} = {}) => {
  try {
    if (!participantId || !projectId || !productId) return null;

    // ── CHECK 1: Is purchase proof (invoice) APPROVED? ──
    const { data: proof } = await supabase
      .from('purchase_proofs')
      .select('id, status')
      .eq('participant_id', participantId)
      .eq('product_id', productId)
      .eq('status', 'APPROVED')
      .maybeSingle();

    // ── CHECK 2: Is participant review APPROVED? ──
    const { data: review } = await supabase
      .from('participant_reviews')
      .select('id, status')
      .eq('participant_id', participantId)
      .eq('product_id', productId)
      .eq('status', 'APPROVED')
      .maybeSingle();

    // ── CRITICAL: Both must be approved ──
    if (!proof || !review) {
      console.log(`[createPayoutIfBothApproved] Waiting - Proof: ${Boolean(proof)}, Review: ${Boolean(review)}`);
      return null;  // Don't create payout yet
    }

    // Get product value
    const { data: product } = await supabase
      .from('project_products')
      .select('product_value')
      .eq('id', productId)
      .maybeSingle();

    if (!product?.product_value) {
      console.log(`[createPayoutIfBothApproved] Product value not found for ${productId}`);
      return null;
    }

    // ── CHECK 3: Does payout already exist? ──
    const { data: existingPayout } = await supabase
      .from('payouts')
      .select('id')
      .eq('participant_id', participantId)
      .eq('project_id', projectId)
      .eq('product_id', productId)
      .in('status', ['ELIGIBLE', 'IN_BATCH', 'EXPORTED', 'PAID'])
      .maybeSingle();

    if (existingPayout) {
      console.log(`[createPayoutIfBothApproved] Payout already exists for product ${productId}`);
      return existingPayout.id;
    }

    // ── CREATE ELIGIBLE PAYOUT ──
    const { data: newPayout, error: insertError } = await supabase
      .from('payouts')
      .insert({
        participant_id: participantId,
        project_id: projectId,
        product_id: productId,
        amount: product.product_value,
        status: 'ELIGIBLE'
      })
      .select()
      .maybeSingle();

    if (insertError) {
      console.error('[createPayoutIfBothApproved] Insert error:', insertError);
      return null;
    }

    console.log(`[createPayoutIfBothApproved] ✅ Created ELIGIBLE payout for product ${productId}`);
    return newPayout?.id;
  } catch (err) {
    console.error('[createPayoutIfBothApproved] Error:', err);
    return null;
  }
};

/**
 * Cleans up duplicate ELIGIBLE payout rows in the DB.
 */
const deduplicatePayoutRows = async (participantId = null) => {
  try {
    let query = supabase
      .from('payouts')
      .select('id, participant_id, project_id, product_id, status, created_at')
      .in('status', ['ELIGIBLE', 'IN_BATCH', 'EXPORTED', 'PAID'])
      .order('created_at', { ascending: true });

    if (participantId) query = query.eq('participant_id', participantId);

    const { data: allPayouts } = await query;
    if (!allPayouts || allPayouts.length === 0) return;

    const seenProjectLevel = new Map();
    const idsToDelete = [];

    for (const row of allPayouts) {
      const projectKey = `${row.participant_id}::${row.project_id}`;
      const productKey = `${row.participant_id}::${row.project_id}::${row.product_id || '__none__'}`;

      if (!seenProjectLevel.has(projectKey)) {
        seenProjectLevel.set(projectKey, new Set([productKey]));
      } else {
        const seenProducts = seenProjectLevel.get(projectKey);
        if (seenProducts.has(productKey)) {
          idsToDelete.push(row.id);
        } else {
          seenProducts.add(productKey);
        }
      }
    }

    if (idsToDelete.length > 0) {
      const batchSize = 50;
      for (let i = 0; i < idsToDelete.length; i += batchSize) {
        await supabase.from('payouts').delete().in('id', idsToDelete.slice(i, i + batchSize));
      }
      console.log(`[deduplicatePayoutRows] Deleted ${idsToDelete.length} duplicate payout row(s)`);
    }
  } catch (err) {
    console.warn('[deduplicatePayoutRows] warning:', err.message || err);
  }
};

/**
 * ✅ Get Eligible payouts (Admin)
 * FIX: Now filters to ONLY show payouts with both invoice AND review APPROVED
 */
const getEligiblePayouts = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('payouts')
      .select('id, participant_id, project_id, product_id, amount, status, created_at, payout_batch_id')
      .eq('status', 'ELIGIBLE')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const rows           = data || [];
    const participantIds = [...new Set(rows.map(r => r.participant_id).filter(Boolean))];
    const projectIds     = [...new Set(rows.map(r => r.project_id).filter(Boolean))];
    const productIds     = [...new Set(rows.map(r => r.product_id).filter(Boolean))];

    const [profilesRes, projectsRes, productsRes] = await Promise.all([
      participantIds.length
        ? supabase.from('profiles').select('id, full_name, email').in('id', participantIds)
        : Promise.resolve({ data: [] }),
      projectIds.length
        ? supabase.from('projects').select('id, title, name, reward').in('id', projectIds)
        : Promise.resolve({ data: [] }),
      productIds.length
        ? supabase.from('project_products').select('id, name, product_value').in('id', productIds)
        : Promise.resolve({ data: [] }),
    ]);

    const profileMap = new Map((profilesRes.data || []).map(r => [r.id, r]));
    const projectMap = new Map((projectsRes.data || []).map(r => [r.id, r]));
    const productMap = new Map((productsRes.data || []).map(r => [r.id, r]));

    // ── NEW VERIFICATION LOGIC ──────────────────────────────────────────────────
    // Only include payouts where BOTH invoice + review are APPROVED
    const verifiedPayouts = await Promise.all(
      rows.map(async (row) => {
        // Check if invoice (purchase_proof) is APPROVED for this product
        const { data: proof } = await supabase
          .from('purchase_proofs')
          .select('id')
          .eq('participant_id', row.participant_id)
          .eq('product_id', row.product_id)
          .eq('status', 'APPROVED')
          .maybeSingle();

        // Check if review is APPROVED for this product
        const { data: review } = await supabase
          .from('participant_reviews')
          .select('id')
          .eq('participant_id', row.participant_id)
          .eq('product_id', row.product_id)
          .eq('status', 'APPROVED')
          .maybeSingle();

        // Only return payout if BOTH are approved
        const isVerified = Boolean(proof) && Boolean(review);
        
        if (!isVerified) {
          console.log(`[getEligiblePayouts] Filtering out unverified payout - Product: ${row.product_id}, Proof: ${Boolean(proof)}, Review: ${Boolean(review)}`);
          return null;
        }

        return row;
      })
    );

    // Remove null entries (unverified payouts)
    const validPayouts = verifiedPayouts.filter(Boolean);
    // ── END OF NEW VERIFICATION LOGIC ────────────────────────────────────────

    // For payouts missing product_id, load all products for those projects
    const rowsNeedingFallback    = validPayouts.filter(r => !r.product_id);
    const allProjectProductMap   = new Map(); // projectId → [product, ...]
    const fallbackAppsByKey      = new Map(); // "pid::projId" → [app, ...]
    const fallbackAppIndexByKey  = new Map(); // tracks sequential assignment index

    if (rowsNeedingFallback.length) {
      const fallbackProjectIds     = [...new Set(rowsNeedingFallback.map(r => r.project_id).filter(Boolean))];
      const fallbackParticipantIds = [...new Set(rowsNeedingFallback.map(r => r.participant_id).filter(Boolean))];

      if (fallbackProjectIds.length) {
        const { data: projProducts } = await supabase
          .from('project_products')
          .select('id, name, product_value, project_id')
          .in('project_id', fallbackProjectIds);
        for (const pp of (projProducts || [])) {
          if (!allProjectProductMap.has(pp.project_id)) allProjectProductMap.set(pp.project_id, []);
          allProjectProductMap.get(pp.project_id).push(pp);
          if (!productMap.has(pp.id)) productMap.set(pp.id, pp);
        }
      }

      if (fallbackParticipantIds.length && fallbackProjectIds.length) {
        const { data: appRows } = await supabase
          .from('project_applications')
          .select('participant_id, project_id, product_id, allocated_budget, status')
          .in('participant_id', fallbackParticipantIds)
          .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);
        for (const app of (appRows || [])) {
          const key = `${app.participant_id}::${app.project_id}`;
          if (!fallbackAppsByKey.has(key)) fallbackAppsByKey.set(key, []);
          fallbackAppsByKey.get(key).push(app);
        }
      }
    }

    // Deduplicate: keep one payout per (participant_id, project_id, product_id)
    const seenPayoutKeys  = new Set();
    const deduplicatedRows = validPayouts.filter(row => {
      const key = `${row.participant_id}::${row.project_id}::${row.product_id || '__none__'}`;
      if (seenPayoutKeys.has(key)) return false;
      seenPayoutKeys.add(key);
      return true;
    });

    const enriched = deduplicatedRows.map(row => {
      const profile = profileMap.get(row.participant_id) || null;
      const project = projectMap.get(row.project_id)     || null;
      const product = productMap.get(row.product_id)     || null;

      // Resolve fallback product when product_id is missing from payout row
      let fallbackProduct = null;
      if (!row.product_id) {
        const projectProducts = allProjectProductMap.get(row.project_id) || [];
        const amountMatch     = projectProducts.find(pp => Number(pp.product_value) === Number(row.amount));
        if (amountMatch) {
          fallbackProduct = amountMatch;
        } else {
          const key     = `${row.participant_id}::${row.project_id}`;
          const appList = fallbackAppsByKey.get(key) || [];
          const idx     = fallbackAppIndexByKey.get(key) || 0;
          const app     = appList[idx] || appList[0] || null;
          fallbackAppIndexByKey.set(key, idx + 1);
          fallbackProduct = app?.product_id ? productMap.get(app.product_id) : null;
        }
      }

      // ── BUG 1 FIX ─────────────────────────────────────────────────────────────
      // product?.product_value MUST be primary — row.amount is LAST RESORT only.
      // row.amount may have been written incorrectly (e.g. ₹664 stored for a ₹308
      // product due to a previous bug). product_value from project_products is always
      // the ground truth for what the participant actually paid.
      const productAmount = Number(
        product?.product_value            // PRIMARY: direct lookup by payout.product_id
        || fallbackProduct?.product_value // SECONDARY: resolved when product_id is null
        || row.amount                     // LAST RESORT: stale DB value
        || 0
      );

      return {
        ...row,
        profiles:      profile,
        projects:      project,
        product_name:  product?.name || fallbackProduct?.name || null,
        reward_amount: 0,
        product_amount: productAmount,
        // ── BUG 2 FIX ───────────────────────────────────────────────────────────
        // fallbackApp was referenced here but defined inside a nested if-block above,
        // causing ReferenceError. The field is unused by the frontend — set to 0.
        allocated_budget: 0,
        total_amount:  productAmount,
      };
    });

    res.json({ success: true, data: enriched, meta: { total: enriched.length } });
  } catch (err) {
    next(err);
  }
};

/**
 * ✅ Get payout batches (Admin) — enriched with participants & products
 */
const getPayoutBatches = async (req, res, next) => {
  try {
    const statusFilter = String(req.query.status || '').toUpperCase();

    let query = supabase.from('payout_batches').select('*').order('created_at', { ascending: false });
    if (statusFilter === 'ACTIVE') query = query.in('status', ['IN_BATCH', 'EXPORTED']);
    if (statusFilter === 'PAID')   query = query.eq('status', 'PAID');

    const { data: batches, error: batchError } = await query;
    if (batchError) throw batchError;
    if (!batches || batches.length === 0) return res.json({ success: true, data: [] });

    const batchIds = batches.map(b => b.id);

    const { data: payouts, error: payoutsError } = await supabase
      .from('payouts')
      .select('id, payout_batch_id, participant_id, product_id, amount, status')
      .in('payout_batch_id', batchIds);
    if (payoutsError) throw payoutsError;

    const payoutRows     = payouts || [];
    const participantIds = [...new Set(payoutRows.map(p => p.participant_id).filter(Boolean))];
    const productIds     = [...new Set(payoutRows.map(p => p.product_id).filter(Boolean))];

    let profileMap = new Map();
    if (participantIds.length) {
      const [profilesRes, detailsRes] = await Promise.all([
        supabase.from('profiles').select('id, full_name, email').in('id', participantIds),
        supabase
          .from('participant_details')
          .select('participant_id, bank_account_number, bank_account_name, bank_ifsc, bank_name, address_line1, address_line2, city, state, pincode, country')
          .in('participant_id', participantIds)
      ]);
      const detailsMap = new Map();
      for (const d of (detailsRes.data || [])) detailsMap.set(d.participant_id, d);
      for (const p of (profilesRes.data || [])) {
        const d = detailsMap.get(p.id) || {};
        profileMap.set(p.id, { ...p, ...d });
      }
    }

    let productMap = new Map();
    if (productIds.length) {
      const { data: products } = await supabase
        .from('project_products').select('id, name, product_value').in('id', productIds);
      for (const p of (products || [])) productMap.set(p.id, p);
    }

    const payoutsWithoutProduct = payoutRows.filter(p => !p.product_id);
    const fallbackProductByKey  = new Map();
    if (payoutsWithoutProduct.length) {
      const { data: appRows } = await supabase
        .from('project_applications')
        .select('participant_id, project_id, product_id, status')
        .in('participant_id', [...new Set(payoutsWithoutProduct.map(p => p.participant_id).filter(Boolean))])
        .not('product_id', 'is', null)
        .in('status', ['PURCHASED', 'COMPLETED', 'APPROVED', 'IN_BATCH', 'PAID']);
      for (const app of (appRows || [])) {
        if (!fallbackProductByKey.has(app.participant_id)) fallbackProductByKey.set(app.participant_id, app.product_id);
      }
      const extraProductIds = [...new Set([...fallbackProductByKey.values()].filter(id => !productMap.has(id)))];
      if (extraProductIds.length) {
        const { data: extraProducts } = await supabase
          .from('project_products').select('id, name, product_value').in('id', extraProductIds);
        for (const p of (extraProducts || [])) productMap.set(p.id, p);
      }
    }

    const participantsByBatch = new Map();
    for (const payout of payoutRows) {
      const bid = payout.payout_batch_id;
      if (!participantsByBatch.has(bid)) participantsByBatch.set(bid, []);
      const profile            = profileMap.get(payout.participant_id) || {};
      const effectiveProductId = payout.product_id || fallbackProductByKey.get(payout.participant_id) || null;
      const product            = effectiveProductId ? (productMap.get(effectiveProductId) || null) : null;
      participantsByBatch.get(bid).push({
        id:                  payout.participant_id,
        payout_id:           payout.id,
        full_name:           profile.full_name           || null,
        email:               profile.email               || null,
        bank_account_number: profile.bank_account_number || null,
        bank_account_name:   profile.bank_account_name   || profile.full_name || null,
        bank_ifsc:           profile.bank_ifsc            || null,
        bank_name:           profile.bank_name            || null,
        address_line1:       profile.address_line1        || null,
        address_line2:       profile.address_line2        || null,
        city:                profile.city                 || null,
        state:               profile.state                || null,
        pincode:             profile.pincode              || null,
        country:             profile.country              || null,
        product_name:        product?.name                || null,
        product_amount:      Number(product?.product_value || 0),
        payout_status:       payout.status,
      });
    }

    res.json({ success: true, data: batches.map(b => ({ ...b, participants: participantsByBatch.get(b.id) || [] })) });
  } catch (err) {
    next(err);
  }
};

/**
 * ✅ Create payout batch (Admin)
 */
const createPayoutBatch = async (req, res, next) => {
  try {
    const { data: eligible, error: eligibleError } = await supabase
      .from('payouts').select('*').eq('status', 'ELIGIBLE');
    if (eligibleError) throw eligibleError;
    if (!eligible || eligible.length === 0) {
      return res.status(400).json({ success: false, message: 'No eligible payouts found' });
    }

    const totalAmount = eligible.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const { data: batch, error: batchError } = await supabase
      .from('payout_batches')
      .insert({ total_amount: totalAmount, status: 'IN_BATCH', created_by: req.user.id })
      .select().single();
    if (batchError) throw batchError;

    const { error: updateError } = await supabase
      .from('payouts')
      .update({ status: 'IN_BATCH', payout_batch_id: batch.id })
      .in('id', eligible.map(p => p.id));
    if (updateError) throw updateError;

    res.json({ success: true, message: 'Payout batch created successfully', data: batch });
  } catch (err) {
    next(err);
  }
};

/**
 * ✅ Mark batch as paid
 */
const markBatchPaid = async (req, res, next) => {
  try {
    const { id } = req.params;

    let payoutsLookup = await supabase
      .from('payouts').select('id, participant_id, project_id, product_id')
      .eq('payout_batch_id', id).in('status', ['IN_BATCH', 'EXPORTED']);
    if (payoutsLookup.error && /product_id/i.test(String(payoutsLookup.error.message || ''))) {
      payoutsLookup = await supabase
        .from('payouts').select('id, participant_id, project_id')
        .eq('payout_batch_id', id).in('status', ['IN_BATCH', 'EXPORTED']);
    }
    const { data: payouts, error: payoutsLookupError } = payoutsLookup;
    if (payoutsLookupError) throw payoutsLookupError;

    const { error: batchError } = await supabase.from('payout_batches').update({ status: 'PAID' }).eq('id', id);
    if (batchError) throw batchError;

    const { error: payoutError } = await supabase.from('payouts').update({ status: 'PAID' }).eq('payout_batch_id', id);
    if (payoutError) throw payoutError;

    const participantIds = [...new Set((payouts || []).map(row => row.participant_id).filter(Boolean))];
    if (participantIds.length) {
      let appRes = await supabase
        .from('project_applications')
        .select('id, participant_id, project_id, product_id, status, reviewed_at, created_at')
        .in('participant_id', participantIds).in('status', ['APPROVED', 'PURCHASED'])
        .order('reviewed_at', { ascending: false }).order('created_at', { ascending: false });
      if (appRes.error && /reviewed_at|created_at/i.test(String(appRes.error.message || ''))) {
        appRes = await supabase
          .from('project_applications')
          .select('id, participant_id, project_id, product_id, status')
          .in('participant_id', participantIds).in('status', ['APPROVED', 'PURCHASED']);
      }
      if (appRes.error) throw appRes.error;

      const latestAppIdByKey = new Map();
      for (const row of (appRes.data || [])) {
        const key = `${row.participant_id}::${row.project_id}::${row.product_id || ''}`;
        if (!latestAppIdByKey.has(key)) latestAppIdByKey.set(key, row.id);
      }

      const appIdsToComplete = [];
      for (const payout of (payouts || [])) {
        const key    = `${payout.participant_id}::${payout.project_id}::${payout.product_id || ''}`;
        const appId  = latestAppIdByKey.get(key) || latestAppIdByKey.get(`${payout.participant_id}::${payout.project_id}::`);
        if (appId) appIdsToComplete.push(appId);
      }

      if (appIdsToComplete.length) {
        const { error: appUpdateError } = await supabase
          .from('project_applications')
          .update({ status: 'COMPLETED', reviewed_at: new Date().toISOString() })
          .in('id', [...new Set(appIdsToComplete)]).in('status', ['APPROVED', 'PURCHASED']);
        if (appUpdateError) throw appUpdateError;
      }
    }

    // Send paid emails
    if ((payouts || []).length > 0) {
      try {
        const paidParticipantIds = [...new Set((payouts || []).map(r => r.participant_id).filter(Boolean))];
        const { data: profiles } = await supabase.from('profiles').select('id, full_name, email').in('id', paidParticipantIds);
        const profileMap = new Map((profiles || []).map(p => [p.id, p]));
        const projectIds = [...new Set((payouts || []).map(r => r.project_id).filter(Boolean))];
        const { data: projectRows } = await supabase.from('projects').select('id, title, name').in('id', projectIds);
        const projMap    = new Map((projectRows || []).map(p => [p.id, p]));
        const productIdList = [...new Set((payouts || []).map(r => r.product_id).filter(Boolean))];
        let productMap = new Map();
        if (productIdList.length) {
          const { data: productRows } = await supabase.from('project_products').select('id, name, product_value').in('id', productIdList);
          productMap = new Map((productRows || []).map(p => [p.id, p]));
        }
        const payoutsByParticipant = new Map();
        for (const row of (payouts || [])) {
          if (!payoutsByParticipant.has(row.participant_id)) payoutsByParticipant.set(row.participant_id, []);
          payoutsByParticipant.get(row.participant_id).push(row);
        }
        for (const [participantId, participantPayouts] of payoutsByParticipant) {
          const profile = profileMap.get(participantId);
          if (!profile?.email) continue;
          const items = participantPayouts.map(row => {
            const project = projMap.get(row.project_id);
            const product = productMap.get(row.product_id);
            return { projectName: project?.title || project?.name || 'Campaign', productName: product?.name || null, amount: Number(product?.product_value || 0) };
          });
          const totalAmount  = items.reduce((s, i) => s + i.amount, 0);
          const dashboardUrl = `${String(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')}/payouts`;
          await sendEmail({ to: profile.email, subject: '💸 Your Nitro Reimbursement Has Been Processed!', html: payoutPaidEmail(profile.full_name || 'Participant', items, totalAmount, dashboardUrl) });
        }
      } catch (emailErr) {
        console.error('[markBatchPaid] Failed to send payout email:', emailErr);
      }
    }

    res.json({ success: true, message: 'Batch marked as paid' });
  } catch (err) {
    next(err);
  }
};

/**
 * Targeted backfill for a specific participant.
 */
const backfillPayoutsForParticipant = async (participantId) => {
  try {
    const { data: apps } = await supabase
      .from('project_applications')
      .select('id, project_id, product_id, allocated_budget, status')
      .eq('participant_id', participantId)
      .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);
    if (!apps || !apps.length) return;

    const projectIds = [...new Set(apps.map(a => a.project_id).filter(Boolean))];
    const productIds = [...new Set(apps.map(a => a.product_id).filter(Boolean))];

    const { data: projects } = await supabase.from('projects').select('id, mode, reward').in('id', projectIds);
    const projectMap = new Map((projects || []).map(p => [p.id, p]));

    const { data: products } = productIds.length
      ? await supabase.from('project_products').select('id, product_value').in('id', productIds)
      : { data: [] };
    const productMap = new Map((products || []).map(p => [p.id, p]));

    let allocIdToProjectId = new Map();
    const allocRes = await supabase.from('unit_allocations').select('id, project_id').eq('participant_id', participantId);
    if (!allocRes.error) for (const a of (allocRes.data || [])) allocIdToProjectId.set(a.id, a.project_id);

    const { data: approvedProofs } = await supabase
      .from('purchase_proofs').select('id, allocation_id, status')
      .eq('participant_id', participantId).eq('status', 'APPROVED');
    const proofProjectSet       = new Set();
    const firstProofIdByProject = new Map();
    for (const p of (approvedProofs || [])) {
      const projId = allocIdToProjectId.get(p.allocation_id);
      if (projId) { proofProjectSet.add(projId); if (!firstProofIdByProject.has(projId)) firstProofIdByProject.set(projId, p.id); }
    }

    const { data: approvedReviews } = await supabase
      .from('participant_reviews').select('id, allocation_id, project_id, status')
      .eq('participant_id', participantId).eq('status', 'APPROVED');
    const reviewProjectSet = new Set();
    for (const r of (approvedReviews || [])) {
      const projId = r.project_id || allocIdToProjectId.get(r.allocation_id);
      if (projId) reviewProjectSet.add(projId);
    }

    const { data: existingPayouts } = await supabase
      .from('payouts').select('project_id, product_id, status').eq('participant_id', participantId);
    const coveredSet = new Set();
    const payoutCountByProject = new Map();
    for (const p of (existingPayouts || [])) {
      if (['ELIGIBLE','IN_BATCH','EXPORTED','PAID'].includes(String(p.status || '').toUpperCase())) {
        coveredSet.add(`${p.project_id}::${p.product_id || '__none__'}`);
        payoutCountByProject.set(p.project_id, (payoutCountByProject.get(p.project_id) || 0) + 1);
      }
    }

    for (const app of apps) {
      const { project_id: projId, product_id: productId } = app;
      if (!projId) continue;

      const project    = projectMap.get(projId);
      const mode       = String(project?.mode || '').toUpperCase();
      // Only create ELIGIBLE payouts after admin-approved submission artifacts:
      // MARKETPLACE: approved review/feedback
      // D2C: approved invoice (proof) AND approved review
      const isEligible = mode === 'MARKETPLACE'
        ? reviewProjectSet.has(projId)
        : (proofProjectSet.has(projId) && reviewProjectSet.has(projId));
      if (!isEligible) continue;

      const covKey = `${projId}::${productId || '__none__'}`;
      if (coveredSet.has(covKey)) continue;

      // ── BUG 3 FIX: amount = product_value only — NO reward component ─────────
      // The participant payouts page shows product_value only (no reward).
      // Previously rewardAmount + productAmount was used here, causing inflated
      // amounts. This is now consistent with backfillEligiblePayouts.
      const productAmount = Number(productMap.get(productId)?.product_value || 0);
      const proofId       = firstProofIdByProject.get(projId) || null;

      // ── FIX: use the same tryInsert pattern as backfillEligiblePayouts ────────
      const basePayload = {
        participant_id:   participantId,
        project_id:       projId,
        product_id:       productId || null,
        purchase_proof_id: proofId || null,
        amount:           productAmount,
        status:           'ELIGIBLE',
      };
      const variants = [
        basePayload,
        { ...basePayload, purchase_proof_id: undefined },
        { ...basePayload, product_id: undefined, purchase_proof_id: undefined },
      ];
      for (const variant of variants) {
        const clean = Object.fromEntries(
          Object.entries(variant).filter(([, v]) => v !== undefined && v !== null)
        );
        const { error } = await supabase.from('payouts').insert(clean);
        if (!error) { coveredSet.add(covKey); break; }
        const msg = String(error.message || '').toLowerCase();
        // Only continue trying variants for schema errors (missing column/table)
        if (!msg.includes('does not exist') && !msg.includes('column') && !msg.includes('schema cache')) break;
      }
    }
  } catch (err) {
    console.error('backfillPayoutsForParticipant error:', err);
  }
};

/**
 * ✅ Get my payouts (Participant)
 */
const getMyPayouts = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    let payoutRes = await supabase
      .from('payouts')
      .select(`id, amount, status, created_at, payout_batch_id, participant_id, project_id, product_id, projects ( id, title, name )`)
      .eq('participant_id', participantId).order('created_at', { ascending: false });

    if (payoutRes.error && /product_id/i.test(String(payoutRes.error.message || ''))) {
      payoutRes = await supabase
        .from('payouts')
        .select(`id, amount, status, created_at, payout_batch_id, participant_id, project_id, projects ( id, title, name )`)
        .eq('participant_id', participantId).order('created_at', { ascending: false });
    }
    const { data, error } = payoutRes;
    if (error) throw error;

    const payoutRows = Array.isArray(data) ? data : [];
    const productIds = [...new Set(payoutRows.map(row => row.product_id).filter(Boolean))];
    let productMap   = new Map();
    if (productIds.length) {
      const { data: productRows, error: productError } = await supabase
        .from('project_products').select('id, name, product_value').in('id', productIds);
      if (productError && !isMissingSchemaObjectError(productError)) throw productError;
      productMap = new Map((productRows || []).map(row => [row.id, row]));
    }

    const uniqueFallbackKeys   = [...new Set(payoutRows.filter(r => !r?.product_id).map(r => `${r.participant_id}::${r.project_id}`))];
    const fallbackProductByKey = new Map();
    if (uniqueFallbackKeys.length) {
      let appRes = await supabase
        .from('project_applications')
        .select('participant_id, project_id, product_id, status, reviewed_at, created_at')
        .eq('participant_id', participantId).not('product_id', 'is', null)
        .in('status', ['PURCHASED', 'COMPLETED', 'APPROVED'])
        .order('reviewed_at', { ascending: false }).order('created_at', { ascending: false });

      if (appRes.error && /reviewed_at|created_at/i.test(String(appRes.error.message || ''))) {
        appRes = await supabase
          .from('project_applications')
          .select('participant_id, project_id, product_id, status')
          .eq('participant_id', participantId).not('product_id', 'is', null).in('status', ['PURCHASED', 'COMPLETED', 'APPROVED']);
      }
      if (appRes.error && !isMissingSchemaObjectError(appRes.error)) throw appRes.error;
      for (const app of (appRes.data || [])) {
        const key = `${app.participant_id}::${app.project_id}`;
        if (!fallbackProductByKey.has(key)) fallbackProductByKey.set(key, app.product_id);
      }
      const missingProductIds = [...new Set(uniqueFallbackKeys.map(k => fallbackProductByKey.get(k)).filter(id => id && !productMap.has(id)))];
      if (missingProductIds.length) {
        const { data: fallbackProducts } = await supabase.from('project_products').select('id, name, product_value').in('id', missingProductIds);
        for (const row of (fallbackProducts || [])) productMap.set(row.id, row);
      }
    }

    const [proofsRes, reviewsRes, appsRes] = await Promise.all([
      supabase
        .from('purchase_proofs')
        .select('id, allocation_id, participant_id, product_id, status, uploaded_at')
        .eq('participant_id', participantId)
        .in('status', ['PENDING', 'APPROVED'])
        .order('uploaded_at', { ascending: false }),
      supabase
        .from('participant_reviews')
        .select('id, participant_id, project_id, product_id, status, created_at')
        .eq('participant_id', participantId)
        .in('status', ['PENDING', 'APPROVED'])
        .order('created_at', { ascending: false }),
      supabase
        .from('project_applications')
        .select('id, participant_id, project_id, product_id, status, reviewed_at, created_at, projects ( id, title, name )')
        .eq('participant_id', participantId)
        .not('product_id', 'is', null)
        .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED'])
        .order('reviewed_at', { ascending: false })
        .order('created_at', { ascending: false })
    ]);

    if (proofsRes.error && !isMissingSchemaObjectError(proofsRes.error)) throw proofsRes.error;
    if (reviewsRes.error && !isMissingSchemaObjectError(reviewsRes.error)) throw reviewsRes.error;
    if (appsRes.error && !isMissingSchemaObjectError(appsRes.error)) throw appsRes.error;

    const latestProofByProduct = new Map();
    for (const proof of (proofsRes.data || [])) {
      if (!proof?.product_id) continue;
      const key = String(proof.product_id);
      if (!latestProofByProduct.has(key)) latestProofByProduct.set(key, proof);
    }

    const latestReviewByProjectProduct = new Map();
    for (const review of (reviewsRes.data || [])) {
      const key = `${review.project_id}::${review.product_id || ''}`;
      if (!latestReviewByProjectProduct.has(key)) latestReviewByProjectProduct.set(key, review);
    }

    const latestAppByProjectProduct = new Map();
    for (const app of (appsRes.data || [])) {
      const key = `${app.project_id}::${app.product_id || ''}`;
      if (!latestAppByProjectProduct.has(key)) latestAppByProjectProduct.set(key, app);
    }

    const appProductIds = [...new Set((appsRes.data || []).map((row) => row.product_id).filter(Boolean))];
    const missingAppProductIds = appProductIds.filter((id) => !productMap.has(id));
    if (missingAppProductIds.length) {
      const { data: appProductRows, error: appProductError } = await supabase
        .from('project_products')
        .select('id, name, product_value')
        .in('id', missingAppProductIds);
      if (appProductError && !isMissingSchemaObjectError(appProductError)) throw appProductError;
      for (const row of (appProductRows || [])) productMap.set(row.id, row);
    }

    const actualPayoutRows = payoutRows;

    const enrichedPayouts = actualPayoutRows.map((row) => {
      const cacheKey = `${row.participant_id}::${row.project_id}`;
      const effectiveProductId = row.product_id || fallbackProductByKey.get(cacheKey) || null;
      const effectiveProduct = effectiveProductId ? (productMap.get(effectiveProductId) || null) : null;

      const mappedValue = effectiveProductId ? Number(effectiveProduct?.product_value || 0) : 0;
      const productAmount = mappedValue > 0 ? mappedValue : Number(row.amount || 0);

      return {
        ...row,
        product_id: effectiveProductId,
        project_products: effectiveProduct,
        reward_amount: 0,
        product_amount: Number.isFinite(productAmount) ? productAmount : 0,
        total_amount: Number.isFinite(productAmount) ? productAmount : 0,
        eligibility_reason:
          row.status === 'PAID' ? 'Payout paid successfully' :
          row.status === 'IN_BATCH' ? 'Included in payout batch' :
          row.status === 'EXPORTED' ? 'Batch exported and waiting for transfer' :
          row.status === 'ELIGIBLE' ? 'Admin approved your invoice and review. Payout will be processed soon.' :
            'Payout eligible and waiting for batch processing'
      };
    });

    // For repeat application cycles, a participant can have older PAID rows for the
    // same (project, product). We still want to show the latest cycle's state.
    const latestPayoutTimeByKey = new Map();
    for (const row of actualPayoutRows) {
      const key = `${row.project_id}::${row.product_id || ''}`;
      const t = new Date(row.created_at || 0).getTime();
      const existing = latestPayoutTimeByKey.get(key) || 0;
      if (t > existing) latestPayoutTimeByKey.set(key, t);
    }

    const syntheticRows = Array.from(latestAppByProjectProduct.values())
      .map((app) => {
        const key = `${app.project_id}::${app.product_id || ''}`;

        // If there's no payout for this key at all, keep old behavior too.
        const latestPayoutTime = latestPayoutTimeByKey.get(key) || 0;

        const appTime = new Date(app.reviewed_at || app.created_at || 0).getTime();
        // Allow small clock/ordering skew between app approval and payout creation.
        const SKEW_MS = 2 * 60 * 1000;
        if (latestPayoutTime && appTime && latestPayoutTime >= (appTime - SKEW_MS)) return null;

        const proof = app.product_id ? (latestProofByProduct.get(String(app.product_id)) || null) : null;
        const review = latestReviewByProjectProduct.get(key) || null;

        // Ignore artifacts from older cycles (before this app was approved/created).
        const proofTime = new Date(proof?.uploaded_at || 0).getTime();
        const reviewTime = new Date(review?.created_at || 0).getTime();
        const proofInThisCycle = Boolean(proof) && (!appTime || proofTime >= appTime);
        const reviewInThisCycle = Boolean(review) && (!appTime || reviewTime >= appTime);

        const product = app.product_id ? (productMap.get(app.product_id) || null) : null;
        const amount = Number(product?.product_value || 0);

        // If participant has submitted both invoice and review for this cycle but no payout row exists yet,
        // show a synthetic "PENDING" row (admin verification in progress).
        if (proofInThisCycle && reviewInThisCycle) {
          const createdAt = review?.created_at || proof?.uploaded_at || app.reviewed_at || app.created_at || null;
          return {
            id: `pending::${app.id}`,
            amount,
            status: 'PENDING',
            created_at: createdAt,
            payout_batch_id: null,
            participant_id: app.participant_id,
            project_id: app.project_id,
            product_id: app.product_id || null,
            projects: app.projects || null,
            project_products: product,
            reward_amount: 0,
            product_amount: amount,
            total_amount: amount,
            eligibility_reason: 'Invoice and review submitted. Waiting for admin approval.'
          };
        }

        // If there is no submission yet for this cycle, do not show anything on the payout page.
        // Payouts should reflect reimbursement tracking, not purchase approval.
        return null;
      })
      .filter(Boolean);

    const finalRows = [...syntheticRows, ...enrichedPayouts]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());

    res.json({ success: true, data: finalRows });
  } catch (err) {
    next(err);
  }
};

/**
 * ✅ Backfill: create ELIGIBLE payout rows for all participants with approved proof/review.
 * KEY FIX: Only creates payouts when BOTH invoice (proof) AND review are approved.
 */
const backfillEligiblePayouts = async () => {
  const SKEW_MS = 10 * 60 * 1000;
  let appRes = await supabase
    .from('project_applications')
    .select('id, participant_id, project_id, product_id, allocated_budget, status, reviewed_at, created_at')
    .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);

  if (appRes.error && /reviewed_at/i.test(String(appRes.error.message || ''))) {
    appRes = await supabase
      .from('project_applications')
      .select('id, participant_id, project_id, product_id, allocated_budget, status, created_at')
      .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);
  }

  const { data: applications, error: appErr } = appRes;
  if (appErr) { console.error('backfill app fetch error:', appErr.message); return; }
  if (!applications || !applications.length) return;

  const participantIds = [...new Set(applications.map(r => r.participant_id).filter(Boolean))];
  const projectIds     = [...new Set(applications.map(r => r.project_id).filter(Boolean))];
  const productIds     = [...new Set(applications.map(r => r.product_id).filter(Boolean))];

  const { data: projects } = await supabase.from('projects').select('id, mode, reward').in('id', projectIds);
  const projectMap = new Map((projects || []).map(p => [p.id, p]));
  const { data: products } = productIds.length
    ? await supabase.from('project_products').select('id, product_value').in('id', productIds)
    : { data: [] };
  const productMap = new Map((products || []).map(p => [p.id, p]));

  const { data: allReviews } = await supabase
    .from('participant_reviews').select('id, participant_id, project_id, allocation_id, status')
    .eq('status', 'APPROVED').in('participant_id', participantIds);
  const proofRes  = await supabase
    .from('purchase_proofs').select('id, participant_id, allocation_id, status')
    .eq('status', 'APPROVED').in('participant_id', participantIds);
  const allProofs = proofRes.data || [];

  const allAllocIds = [...new Set([...(allReviews || []).map(r => r.allocation_id), ...allProofs.map(p => p.allocation_id)].filter(Boolean))];
  let allocMap = new Map();
  if (allAllocIds.length) {
    const { data: allocs } = await supabase.from('unit_allocations').select('id, project_id').in('id', allAllocIds);
    allocMap = new Map((allocs || []).map(a => [a.id, a.project_id]));
  }

  const eligibilityMap = new Map();
  const getOrCreate    = (pid, projId) => {
    const key = `${pid}::${projId}`;
    if (!eligibilityMap.has(key)) eligibilityMap.set(key, { hasReview: false, hasProof: false, proofId: null });
    return eligibilityMap.get(key);
  };
  for (const review of (allReviews || [])) { const pid = review.project_id || allocMap.get(review.allocation_id); if (pid) getOrCreate(review.participant_id, pid).hasReview = true; }
  for (const proof of allProofs) { const pid = allocMap.get(proof.allocation_id); if (pid) { const e = getOrCreate(proof.participant_id, pid); e.hasProof = true; if (!e.proofId) e.proofId = proof.id; } }

  const { data: existingPayouts } = await supabase
    .from('payouts').select('participant_id, project_id, product_id, status, created_at')
    .in('participant_id', participantIds).in('project_id', projectIds);

  // Repeat application cycles can legitimately create multiple payouts for the same
  // (participant, project, product) across time. We only skip inserting when there is
  // already a payout row created for the current cycle (based on timestamps).
  const latestPayoutTimeByKey = new Map();
  const coveredSet = new Set();
  for (const p of (existingPayouts || [])) {
    if (!['ELIGIBLE', 'IN_BATCH', 'EXPORTED', 'PAID'].includes(String(p.status || '').toUpperCase())) continue;
    const key = `${p.participant_id}::${p.project_id}::${p.product_id || '__none__'}`;
    coveredSet.add(key);
    const t = new Date(p.created_at || 0).getTime();
    const existing = latestPayoutTimeByKey.get(key) || 0;
    if (t > existing) latestPayoutTimeByKey.set(key, t);
  }

  const tryInsert = async (payload) => {
    for (const v of [payload, { ...payload, purchase_proof_id: undefined }]) {
      const clean = Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined));

      // Prefer idempotent writes when a unique constraint exists (recommended for ELIGIBLE rows).
      let writeRes = await supabase
        .from('payouts')
        .upsert(clean, {
          onConflict: 'participant_id,project_id,product_id,status',
          ignoreDuplicates: true
        });

      if (writeRes.error) {
        const msg = String(writeRes.error.message || '').toLowerCase();

        // If ON CONFLICT isn't supported due to missing constraint, fall back to plain insert.
        const conflictUnsupported =
          msg.includes('no unique')
          || msg.includes('on conflict')
          || msg.includes('unique or exclusion constraint');

        if (conflictUnsupported || isMissingSchemaObjectError(writeRes.error)) {
          writeRes = await supabase.from('payouts').insert(clean);
        }
      }

      if (!writeRes.error) return true;

      const finalMsg = String(writeRes.error.message || '').toLowerCase();
      if (!finalMsg.includes('does not exist') && !finalMsg.includes('column') && !finalMsg.includes('schema cache')) return false;
    }
    return false;
  };

  for (const app of applications) {
    const { participant_id: pid, project_id: projId, product_id: productId } = app;
    if (!pid || !projId) continue;
    const eligi = eligibilityMap.get(`${pid}::${projId}`);
    const mode       = String(projectMap.get(projId)?.mode || '').toUpperCase();
    // Only create ELIGIBLE payouts after admin-approved submission artifacts:
    // MARKETPLACE: approved review
    // D2C: approved invoice (proof) AND approved review ← THIS IS CORRECT
    const isEligible = Boolean(eligi) && (
      mode === 'MARKETPLACE'
        ? eligi.hasReview
        : (eligi.hasProof && eligi.hasReview)
    );
    if (!isEligible) continue;
    const covKey = `${pid}::${projId}::${productId || '__none__'}`;

    // Allow a new ELIGIBLE payout when the application is from a newer cycle than
    // the last recorded payout for this same (participant, project, product).
    const appTime = new Date(app.created_at || app.reviewed_at || 0).getTime();
    const lastPayoutTime = latestPayoutTimeByKey.get(covKey) || 0;
    if (coveredSet.has(covKey) && appTime && lastPayoutTime >= (appTime - SKEW_MS)) continue;
    const productAmount = Number(productMap.get(productId)?.product_value || 0);
    const inserted = await tryInsert({ participant_id: pid, project_id: projId, product_id: productId || null, purchase_proof_id: eligi?.proofId || null, amount: productAmount, status: 'ELIGIBLE' });
    if (inserted) {
      coveredSet.add(covKey);
      latestPayoutTimeByKey.set(covKey, Date.now());
    }
  }
};

module.exports = { 
  getEligiblePayouts, 
  getPayoutBatches, 
  createPayoutBatch, 
  markBatchPaid, 
  getMyPayouts, 
  backfillEligiblePayouts,
  createPayoutIfBothApproved,
  deduplicatePayoutRows
};
