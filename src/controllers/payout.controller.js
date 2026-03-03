const supabase = require('../config/supabaseClient');
const { calculatePayoutBreakdown } = require('../utils/payout.utils');
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
 * ✅ Get Eligible payouts (Admin)
 * FIX: Added backfillEligiblePayouts() call so payouts are auto-created
 * when review/proof is approved before this page loads.
 */
const getEligiblePayouts = async (req, res, next) => {
  try {
    // Run backfill first so any approved reviews/proofs without a payout row get one
    await backfillEligiblePayouts();

    const { data, error } = await supabase
      .from('payouts')
      .select('id, participant_id, project_id, product_id, amount, status, created_at, payout_batch_id')
      .eq('status', 'ELIGIBLE')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Enrich with profile info for display
    const rows = data || [];
    const participantIds = [...new Set(rows.map(r => r.participant_id).filter(Boolean))];
    const projectIds = [...new Set(rows.map(r => r.project_id).filter(Boolean))];
    const productIds = [...new Set(rows.map(r => r.product_id).filter(Boolean))];

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

    // For payouts missing product_id, resolve via applications
    const rowsNeedingFallback = rows.filter(r => !r.product_id);
    const fallbackProductMap = new Map();
    if (rowsNeedingFallback.length) {
      const { data: appRows } = await supabase
        .from('project_applications')
        .select('participant_id, project_id, product_id, allocated_budget, status')
        .in('participant_id', [...new Set(rowsNeedingFallback.map(r => r.participant_id).filter(Boolean))])
        .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);
      for (const app of (appRows || [])) {
        const key = `${app.participant_id}::${app.project_id}`;
        if (!fallbackProductMap.has(key)) fallbackProductMap.set(key, app);
      }
    }

    const enriched = rows.map(row => {
      const profile = profileMap.get(row.participant_id) || null;
      const project = projectMap.get(row.project_id) || null;
      const product = productMap.get(row.product_id) || null;
      const fallbackApp = fallbackProductMap.get(`${row.participant_id}::${row.project_id}`) || null;
      const fallbackProduct = fallbackApp?.product_id ? productMap.get(fallbackApp.product_id) : null;

      const rewardAmount = Number(project?.reward || 0);
      // Only product_value — no reward added
      const productAmount = Number(
        product?.product_value ||
        fallbackProduct?.product_value || 0
      );

      return {
        ...row,
        profiles: profile,
        projects: project,
        product_name: product?.name || fallbackProduct?.name || null,
        reward_amount: 0,
        product_amount: productAmount,
        allocated_budget: Number(fallbackApp?.allocated_budget || 0),
        total_amount: productAmount,
      };
    });

    res.json({
      success: true,
      data: enriched,
      meta: { total: enriched.length }
    });
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

    let query = supabase
      .from('payout_batches')
      .select('*')
      .order('created_at', { ascending: false });

    if (statusFilter === 'ACTIVE') {
      query = query.in('status', ['IN_BATCH', 'EXPORTED']);
    }
    if (statusFilter === 'PAID') {
      query = query.eq('status', 'PAID');
    }

    const { data: batches, error: batchError } = await query;
    if (batchError) throw batchError;

    if (!batches || batches.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const batchIds = batches.map((b) => b.id);

    // Fetch all payouts for these batches
    const { data: payouts, error: payoutsError } = await supabase
      .from('payouts')
      .select('id, payout_batch_id, participant_id, product_id, amount, status')
      .in('payout_batch_id', batchIds);
    if (payoutsError) throw payoutsError;

    const payoutRows = payouts || [];

    // Collect unique participant IDs and product IDs
    const participantIds = [...new Set(payoutRows.map((p) => p.participant_id).filter(Boolean))];
    const productIds = [...new Set(payoutRows.map((p) => p.product_id).filter(Boolean))];

    // Fetch profiles
    let profileMap = new Map();
    if (participantIds.length) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, email, bank_account_number, bank_ifsc, address_line1, address_line2, city, state, pincode, country')
        .in('id', participantIds);
      for (const p of (profiles || [])) profileMap.set(p.id, p);
    }

    // Fetch products
    let productMap = new Map();
    if (productIds.length) {
      const { data: products } = await supabase
        .from('project_products')
        .select('id, name, product_value')
        .in('id', productIds);
      for (const p of (products || [])) productMap.set(p.id, p);
    }

    // For payouts missing product_id, try to resolve via project_applications
    const payoutsWithoutProduct = payoutRows.filter((p) => !p.product_id);
    const fallbackProductByKey = new Map();
    if (payoutsWithoutProduct.length) {
      const { data: appRows } = await supabase
        .from('project_applications')
        .select('participant_id, project_id, product_id, status')
        .in('participant_id', [...new Set(payoutsWithoutProduct.map((p) => p.participant_id).filter(Boolean))])
        .not('product_id', 'is', null)
        .in('status', ['PURCHASED', 'COMPLETED', 'APPROVED', 'IN_BATCH', 'PAID']);

      for (const app of (appRows || [])) {
        const key = `${app.participant_id}`;
        if (!fallbackProductByKey.has(key)) {
          fallbackProductByKey.set(key, app.product_id);
        }
      }

      // Fetch any product details not yet in productMap
      const extraProductIds = [...new Set(
        [...fallbackProductByKey.values()].filter((id) => !productMap.has(id))
      )];
      if (extraProductIds.length) {
        const { data: extraProducts } = await supabase
          .from('project_products')
          .select('id, name, product_value')
          .in('id', extraProductIds);
        for (const p of (extraProducts || [])) productMap.set(p.id, p);
      }
    }

    // Build a map of batchId → array of participant rows
    const participantsByBatch = new Map();
    for (const payout of payoutRows) {
      const bid = payout.payout_batch_id;
      if (!participantsByBatch.has(bid)) participantsByBatch.set(bid, []);

      const profile = profileMap.get(payout.participant_id) || {};
      const effectiveProductId = payout.product_id || fallbackProductByKey.get(payout.participant_id) || null;
      const product = effectiveProductId ? (productMap.get(effectiveProductId) || null) : null;

      participantsByBatch.get(bid).push({
        id: payout.participant_id,
        payout_id: payout.id,
        full_name: profile.full_name || null,
        email: profile.email || null,
        bank_account_number: profile.bank_account_number || null,
        bank_ifsc: profile.bank_ifsc || null,
        address_line1: profile.address_line1 || null,
        address_line2: profile.address_line2 || null,
        city: profile.city || null,
        state: profile.state || null,
        pincode: profile.pincode || null,
        country: profile.country || null,
        product_name: product?.name || null,
        product_amount: Number(product?.product_value || 0), // Always use product_value, never stale payout.amount
        payout_status: payout.status,
      });
    }

    // Attach participants to each batch
    const enriched = batches.map((batch) => ({
      ...batch,
      participants: participantsByBatch.get(batch.id) || [],
    }));

    res.json({ success: true, data: enriched });

  } catch (err) {
    next(err);
  }
};

/**
 * ✅ Create payout batch (Admin)
 */
const createPayoutBatch = async (req, res, next) => {
  try {

    // 1️⃣ Get all ELIGIBLE payouts
    const { data: eligible, error: eligibleError } = await supabase
      .from('payouts')
      .select('*')
      .eq('status', 'ELIGIBLE');

    if (eligibleError) throw eligibleError;

    if (!eligible || eligible.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No eligible payouts found'
      });
    }

    const totalAmount = eligible.reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0
    );

    // 2️⃣ Create batch
    const { data: batch, error: batchError } = await supabase
      .from('payout_batches')
      .insert({
        total_amount: totalAmount,
        status: 'IN_BATCH',
        created_by: req.user.id
      })
      .select()
      .single();

    if (batchError) throw batchError;

    // 3️⃣ Update payouts
    const payoutIds = eligible.map(p => p.id);

    const { error: updateError } = await supabase
      .from('payouts')
      .update({
        status: 'IN_BATCH',
        payout_batch_id: batch.id
      })
      .in('id', payoutIds);

    if (updateError) throw updateError;

    res.json({
      success: true,
      message: 'Payout batch created successfully',
      data: batch
    });

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
      .from('payouts')
      .select('id, participant_id, project_id, product_id')
      .eq('payout_batch_id', id)
      .in('status', ['IN_BATCH', 'EXPORTED']);

    if (payoutsLookup.error && /product_id/i.test(String(payoutsLookup.error.message || ''))) {
      payoutsLookup = await supabase
        .from('payouts')
        .select('id, participant_id, project_id')
        .eq('payout_batch_id', id)
        .in('status', ['IN_BATCH', 'EXPORTED']);
    }

    const { data: payouts, error: payoutsLookupError } = payoutsLookup;
    if (payoutsLookupError) throw payoutsLookupError;

    const { error: batchError } = await supabase
      .from('payout_batches')
      .update({ status: 'PAID' })
      .eq('id', id);

    if (batchError) throw batchError;

    const { error: payoutError } = await supabase
      .from('payouts')
      .update({ status: 'PAID' })
      .eq('payout_batch_id', id);

    if (payoutError) throw payoutError;

    const participantIds = [...new Set((payouts || []).map((row) => row.participant_id).filter(Boolean))];
    if (participantIds.length) {
      let appRes = await supabase
        .from('project_applications')
        .select('id, participant_id, project_id, product_id, status, reviewed_at, created_at')
        .in('participant_id', participantIds)
        .in('status', ['APPROVED', 'PURCHASED'])
        .order('reviewed_at', { ascending: false })
        .order('created_at', { ascending: false });

      if (appRes.error && /reviewed_at|created_at/i.test(String(appRes.error.message || ''))) {
        appRes = await supabase
          .from('project_applications')
          .select('id, participant_id, project_id, product_id, status')
          .in('participant_id', participantIds)
          .in('status', ['APPROVED', 'PURCHASED']);
      }

      if (appRes.error) throw appRes.error;

      const latestAppIdByKey = new Map();
      for (const row of (appRes.data || [])) {
        const key = `${row.participant_id}::${row.project_id}::${row.product_id || ''}`;
        if (!latestAppIdByKey.has(key)) {
          latestAppIdByKey.set(key, row.id);
        }
      }

      const appIdsToComplete = [];
      for (const payout of (payouts || [])) {
        const key = `${payout.participant_id}::${payout.project_id}::${payout.product_id || ''}`;
        const appId = latestAppIdByKey.get(key);
        if (!appId) {
          const fallbackKey = `${payout.participant_id}::${payout.project_id}::`;
          const fallbackAppId = latestAppIdByKey.get(fallbackKey);
          if (fallbackAppId) appIdsToComplete.push(fallbackAppId);
          continue;
        }
        if (appId) appIdsToComplete.push(appId);
      }

      if (appIdsToComplete.length) {
        const { error: appUpdateError } = await supabase
          .from('project_applications')
          .update({
            status: 'COMPLETED',
            reviewed_at: new Date().toISOString()
          })
          .in('id', [...new Set(appIdsToComplete)])
          .in('status', ['APPROVED', 'PURCHASED']);

        if (appUpdateError) throw appUpdateError;
      }
    }

    res.json({
      success: true,
      message: 'Batch marked as paid'
    });

  } catch (err) {
    next(err);
  }
};

/**
 * ✅ Get my payouts (Participant) — unchanged
 */
const getMyPayouts = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    let payoutRes = await supabase
      .from('payouts')
      .select(`
        id,
        amount,
        status,
        created_at,
        payout_batch_id,
        participant_id,
        project_id,
        product_id,
        projects (
          id,
          title,
          name
        )
      `)
      .eq('participant_id', participantId)
      .order('created_at', { ascending: false });

    if (payoutRes.error && /product_id/i.test(String(payoutRes.error.message || ''))) {
      payoutRes = await supabase
        .from('payouts')
        .select(`
          id,
          amount,
          status,
          created_at,
          payout_batch_id,
          participant_id,
          project_id,
          projects (
            id,
            title,
            name
          )
        `)
        .eq('participant_id', participantId)
        .order('created_at', { ascending: false });
    }

    const { data, error } = payoutRes;
    if (error) throw error;

    const payoutRows = Array.isArray(data) ? data : [];
    const productIds = [...new Set((data || []).map((row) => row.product_id).filter(Boolean))];
    let productMap = new Map();
    if (productIds.length) {
      const { data: productRows, error: productError } = await supabase
        .from('project_products')
        .select('id, name, product_value')
        .in('id', productIds);
      if (productError && !isMissingSchemaObjectError(productError)) throw productError;
      productMap = new Map((productRows || []).map((row) => [row.id, row]));
    }

    const payoutKeysNeedingFallback = payoutRows
      .filter((row) => !row?.product_id)
      .map((row) => `${row.participant_id}::${row.project_id}`);
    const uniqueFallbackKeys = [...new Set(payoutKeysNeedingFallback)];
    const fallbackProductByKey = new Map();

    if (uniqueFallbackKeys.length) {
      let appRes = await supabase
        .from('project_applications')
        .select('participant_id, project_id, product_id, status, reviewed_at, created_at')
        .eq('participant_id', participantId)
        .not('product_id', 'is', null)
        .in('status', ['PURCHASED', 'COMPLETED', 'APPROVED'])
        .order('reviewed_at', { ascending: false })
        .order('created_at', { ascending: false });

      if (appRes.error && /reviewed_at|created_at/i.test(String(appRes.error.message || ''))) {
        appRes = await supabase
          .from('project_applications')
          .select('participant_id, project_id, product_id, status')
          .eq('participant_id', participantId)
          .not('product_id', 'is', null)
          .in('status', ['PURCHASED', 'COMPLETED', 'APPROVED']);
      }

      if (appRes.error && !isMissingSchemaObjectError(appRes.error)) throw appRes.error;

      for (const app of (appRes.data || [])) {
        const key = `${app.participant_id}::${app.project_id}`;
        if (!fallbackProductByKey.has(key)) {
          fallbackProductByKey.set(key, app.product_id);
        }
      }

      const fallbackProductIds = [...new Set(
        uniqueFallbackKeys
          .map((key) => fallbackProductByKey.get(key))
          .filter(Boolean)
      )];

      const missingProductIds = fallbackProductIds.filter((id) => !productMap.has(id));
      if (missingProductIds.length) {
        const { data: fallbackProducts, error: fallbackProductsError } = await supabase
          .from('project_products')
          .select('id, name, product_value')
          .in('id', missingProductIds);
        if (fallbackProductsError && !isMissingSchemaObjectError(fallbackProductsError)) throw fallbackProductsError;
        for (const row of (fallbackProducts || [])) {
          productMap.set(row.id, row);
        }
      }
    }

    const breakdownCache = new Map();

    const enriched = await Promise.all((payoutRows || []).map(async (row) => {
      const cacheKey = `${row.participant_id}::${row.project_id}`;
      let breakdown = breakdownCache.get(cacheKey);

      if (!breakdown) {
        breakdown = await calculatePayoutBreakdown({
          supabase,
          participantId: row.participant_id,
          projectId: row.project_id
        });
        breakdownCache.set(cacheKey, breakdown);
      }

      const effectiveProductId = row.product_id || fallbackProductByKey.get(cacheKey) || null;
      const effectiveProduct = effectiveProductId ? (productMap.get(effectiveProductId) || null) : null;

      // Only product_value — no reward added
      const productAmount = effectiveProductId
        ? Number(effectiveProduct?.product_value || 0)
        : breakdown.productAmount;

      return {
        ...row,
        product_id: effectiveProductId,
        project_products: effectiveProduct,
        reward_amount: 0,
        product_amount: productAmount,
        total_amount: productAmount,
        eligibility_reason:
          row.status === 'PAID'
            ? 'Payout paid successfully'
            : row.status === 'IN_BATCH'
              ? 'Included in payout batch'
              : row.status === 'EXPORTED'
                ? 'Batch exported and waiting for transfer'
                : 'Payout eligible and waiting for batch processing'
      };
    }));

    res.json({
      success: true,
      data: enriched
    });

  } catch (err) {
    next(err);
  }
};


/**
 * Backfill: create ELIGIBLE payout rows for participants who have
 * approved reviews or proofs but no payout row yet.
 * Safe to run on every page load — only inserts missing rows.
 */
const backfillEligiblePayouts = async () => {
  const { data: applications, error: appErr } = await supabase
    .from('project_applications')
    .select('id, participant_id, project_id, product_id, allocated_budget, status')
    .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);
  if (appErr) { console.error('backfill app fetch error:', appErr.message); return; }
  if (!applications || !applications.length) return;

  const participantIds = [...new Set(applications.map(r => r.participant_id).filter(Boolean))];
  const projectIds = [...new Set(applications.map(r => r.project_id).filter(Boolean))];
  const productIds = [...new Set(applications.map(r => r.product_id).filter(Boolean))];

  const { data: projects } = await supabase
    .from('projects').select('id, mode, reward').in('id', projectIds);
  const projectMap = new Map((projects || []).map(p => [p.id, p]));

  const { data: products } = productIds.length
    ? await supabase.from('project_products').select('id, product_value').in('id', productIds)
    : { data: [] };
  const productMap = new Map((products || []).map(p => [p.id, p]));

  const { data: allReviews } = await supabase
    .from('participant_reviews')
    .select('id, participant_id, project_id, allocation_id, status')
    .eq('status', 'APPROVED')
    .in('participant_id', participantIds);

  let proofRes = await supabase
    .from('purchase_proofs')
    .select('id, participant_id, allocation_id, status')
    .eq('status', 'APPROVED')
    .in('participant_id', participantIds);
  const allProofs = proofRes.data || [];

  const allAllocIds = [...new Set([
    ...(allReviews || []).map(r => r.allocation_id),
    ...allProofs.map(p => p.allocation_id),
  ].filter(Boolean))];

  let allocMap = new Map();
  if (allAllocIds.length) {
    const { data: allocs } = await supabase
      .from('unit_allocations').select('id, project_id').in('id', allAllocIds);
    allocMap = new Map((allocs || []).map(a => [a.id, a.project_id]));
  }

  const eligibilityMap = new Map();
  const getOrCreate = (pid, projId) => {
    const key = `${pid}::${projId}`;
    if (!eligibilityMap.has(key)) eligibilityMap.set(key, { hasReview: false, hasProof: false, proofId: null });
    return eligibilityMap.get(key);
  };

  for (const review of (allReviews || [])) {
    const pid = review.project_id || allocMap.get(review.allocation_id);
    if (pid) getOrCreate(review.participant_id, pid).hasReview = true;
  }
  for (const proof of allProofs) {
    const pid = allocMap.get(proof.allocation_id);
    if (pid) {
      const entry = getOrCreate(proof.participant_id, pid);
      entry.hasProof = true;
      if (!entry.proofId) entry.proofId = proof.id;
    }
  }

  const { data: existingPayouts } = await supabase
    .from('payouts')
    .select('participant_id, project_id, product_id, status')
    .in('participant_id', participantIds)
    .in('project_id', projectIds);

  const coveredSet = new Set();
  for (const p of (existingPayouts || [])) {
    if (['ELIGIBLE','IN_BATCH','EXPORTED','PAID'].includes(String(p.status || '').toUpperCase())) {
      coveredSet.add(`${p.participant_id}::${p.project_id}::${p.product_id || '__none__'}`);
    }
  }

  const tryInsert = async (payload) => {
    const variants = [
      payload,
      { ...payload, user_id: undefined },
      { ...payload, purchase_proof_id: undefined },
      { ...payload, user_id: undefined, purchase_proof_id: undefined },
    ];
    for (const v of variants) {
      const clean = Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined));
      const { error } = await supabase.from('payouts').insert(clean);
      if (!error) return true;
      const msg = String(error.message || '').toLowerCase();
      if (!msg.includes('does not exist') && !msg.includes('column') && !msg.includes('schema cache')) {
        return false;
      }
    }
    return false;
  };

  for (const app of applications) {
    const { participant_id: pid, project_id: projId, product_id: productId } = app;
    if (!pid || !projId) continue;

    const eligi = eligibilityMap.get(`${pid}::${projId}`);
    if (!eligi) continue;

    const project = projectMap.get(projId);
    const mode = String(project?.mode || '').toUpperCase();
    const isEligible = mode === 'MARKETPLACE' ? eligi.hasReview : (eligi.hasProof || eligi.hasReview);
    if (!isEligible) continue;

    const covKey = `${pid}::${projId}::${productId || '__none__'}`;
    if (coveredSet.has(covKey)) continue;

    // Only product_value — no reward added
    const productAmount = Number(productMap.get(productId)?.product_value || 0);

    const inserted = await tryInsert({
      participant_id: pid,
      user_id: pid,
      project_id: projId,
      product_id: productId || null,
      purchase_proof_id: eligi.proofId || null,
      amount: productAmount,
      status: 'ELIGIBLE',
    });
    if (inserted) coveredSet.add(covKey);
  }
};

module.exports = {
  getEligiblePayouts,
  getPayoutBatches,
  createPayoutBatch,
  markBatchPaid,
  getMyPayouts,
  backfillEligiblePayouts
};