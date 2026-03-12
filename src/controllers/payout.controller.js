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
 */
const getEligiblePayouts = async (req, res, next) => {
  try {
    await deduplicatePayoutRows();
    await backfillEligiblePayouts();

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

    // For payouts missing product_id, load all products for those projects
    const rowsNeedingFallback    = rows.filter(r => !r.product_id);
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
    const deduplicatedRows = rows.filter(row => {
      const key = `${row.participant_id}::${row.project_id}::${row.product_id || '__none__'}`;
      if (seenPayoutKeys.has(key)) return false;
      seenPayoutKeys.add(key);
      return true;
    });

    const enriched = deduplicatedRows.map(row => {
      const profile = profileMap.get(row.participant_id) || null;
      const project = projectMap.get(row.project_id)     || null;
      // Direct product lookup by payout.product_id — always the most accurate source
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
    const appCountByProject = new Map();
    for (const app of apps) { if (app.project_id) appCountByProject.set(app.project_id, (appCountByProject.get(app.project_id) || 0) + 1); }
    for (const [projId, payoutCount] of payoutCountByProject.entries()) {
      const appCount = appCountByProject.get(projId) || 0;
      if (payoutCount >= appCount && appCount > 0) {
        for (const app of apps) { if (app.project_id === projId) coveredSet.add(`${projId}::${app.product_id || '__none__'}`); }
      }
    }

    for (const app of apps) {
      const { project_id: projId, product_id: productId } = app;
      if (!projId) continue;

      const project    = projectMap.get(projId);
      const mode       = String(project?.mode || '').toUpperCase();
      const isEligible = mode === 'MARKETPLACE' ? reviewProjectSet.has(projId) : (proofProjectSet.has(projId) || reviewProjectSet.has(projId));
      if (!isEligible) continue;

      const covKey = `${projId}::${productId || '__none__'}`;
      if (coveredSet.has(covKey)) continue;

      // ── BUG 3 FIX: amount = product_value only — NO reward component ─────────
      // The participant payouts page shows product_value only (no reward).
      // Previously rewardAmount + productAmount was used here, causing inflated
      // amounts. This is now consistent with backfillEligiblePayouts.
      const productAmount = Number(productMap.get(productId)?.product_value || 0);
      const proofId       = firstProofIdByProject.get(projId) || null;

      const candidates = [
        { participant_id: participantId, user_id: participantId, project_id: projId, product_id: productId || null, purchase_proof_id: proofId, amount: productAmount, status: 'ELIGIBLE' },
        { participant_id: participantId, user_id: participantId, project_id: projId, product_id: productId || null, amount: productAmount, status: 'ELIGIBLE' },
        { participant_id: participantId, project_id: projId, product_id: productId || null, amount: productAmount, status: 'ELIGIBLE' },
        { participant_id: participantId, project_id: projId, amount: productAmount, status: 'ELIGIBLE' },
      ];
      for (const c of candidates) {
        const clean = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== null || typeof v === 'number'));
        const { error } = await supabase.from('payouts').insert(clean);
        if (!error) { coveredSet.add(covKey); break; }
        const msg = String(error.message || '').toLowerCase();
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
    await deduplicatePayoutRows(participantId);
    await backfillPayoutsForParticipant(participantId);

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

    const breakdownCache = new Map();
    const enrichedPayouts = await Promise.all(actualPayoutRows.map(async row => {
      const cacheKey = `${row.participant_id}::${row.project_id}`;
      let breakdown  = breakdownCache.get(cacheKey);
      if (!breakdown) {
        breakdown = await calculatePayoutBreakdown({ supabase, participantId: row.participant_id, projectId: row.project_id });
        breakdownCache.set(cacheKey, breakdown);
      }
      const effectiveProductId = row.product_id || fallbackProductByKey.get(cacheKey) || null;
      const effectiveProduct   = effectiveProductId ? (productMap.get(effectiveProductId) || null) : null;
      const productAmount      = effectiveProductId ? Number(effectiveProduct?.product_value || 0) : breakdown.productAmount;
      return {
        ...row,
        product_id:         effectiveProductId,
        project_products:   effectiveProduct,
        reward_amount:      0,
        product_amount:     productAmount,
        total_amount:       productAmount,
        eligibility_reason:
          row.status === 'PAID'     ? 'Payout paid successfully' :
          row.status === 'IN_BATCH' ? 'Included in payout batch' :
          row.status === 'EXPORTED' ? 'Batch exported and waiting for transfer' :
                                      'Payout eligible and waiting for batch processing'
      };
    }));

    const existingActualKeys = new Set(
      actualPayoutRows.map((row) => `${row.project_id}::${row.product_id || ''}`)
    );

    const syntheticPendingRows = Array.from(latestAppByProjectProduct.values())
      .map((app) => {
        const key = `${app.project_id}::${app.product_id || ''}`;
        if (existingActualKeys.has(key)) return null;

        const proof = app.product_id ? latestProofByProduct.get(String(app.product_id)) || null : null;
        const review = latestReviewByProjectProduct.get(key) || null;
        if (!proof || !review) return null;

        const product = app.product_id ? (productMap.get(app.product_id) || null) : null;
        const createdAt = review?.created_at || proof?.uploaded_at || app.reviewed_at || app.created_at || null;

        return {
          id: `pending::${app.id}`,
          amount: Number(product?.product_value || 0),
          status: 'PENDING',
          created_at: createdAt,
          payout_batch_id: null,
          participant_id: app.participant_id,
          project_id: app.project_id,
          product_id: app.product_id || null,
          projects: app.projects || null,
          project_products: product,
          reward_amount: 0,
          product_amount: Number(product?.product_value || 0),
          total_amount: Number(product?.product_value || 0),
          eligibility_reason: 'Invoice and review submitted. Waiting for admin approval.'
        };
      })
      .filter(Boolean);

    const finalRows = [...syntheticPendingRows, ...enrichedPayouts]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());

    res.json({ success: true, data: finalRows });
  } catch (err) {
    next(err);
  }
};

/**
 * Backfill: create ELIGIBLE payout rows for all participants with approved proof/review.
 */
const backfillEligiblePayouts = async () => {
  const { data: applications, error: appErr } = await supabase
    .from('project_applications')
    .select('id, participant_id, project_id, product_id, allocated_budget, status')
    .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);
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
    .from('payouts').select('participant_id, project_id, product_id, status')
    .in('participant_id', participantIds).in('project_id', projectIds);
  const coveredSet = new Set();
  for (const p of (existingPayouts || [])) {
    if (['ELIGIBLE','IN_BATCH','EXPORTED','PAID'].includes(String(p.status || '').toUpperCase()))
      coveredSet.add(`${p.participant_id}::${p.project_id}::${p.product_id || '__none__'}`);
  }

  const tryInsert = async (payload) => {
    for (const v of [payload, { ...payload, user_id: undefined }, { ...payload, purchase_proof_id: undefined }, { ...payload, user_id: undefined, purchase_proof_id: undefined }]) {
      const clean = Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined));
      const { error } = await supabase.from('payouts').insert(clean);
      if (!error) return true;
      const msg = String(error.message || '').toLowerCase();
      if (!msg.includes('does not exist') && !msg.includes('column') && !msg.includes('schema cache')) return false;
    }
    return false;
  };

  for (const app of applications) {
    const { participant_id: pid, project_id: projId, product_id: productId } = app;
    if (!pid || !projId) continue;
    const eligi = eligibilityMap.get(`${pid}::${projId}`);
    if (!eligi) continue;
    const mode       = String(projectMap.get(projId)?.mode || '').toUpperCase();
    const isEligible = mode === 'MARKETPLACE' ? eligi.hasReview : (eligi.hasProof || eligi.hasReview);
    if (!isEligible) continue;
    const covKey = `${pid}::${projId}::${productId || '__none__'}`;
    if (coveredSet.has(covKey)) continue;
    const productAmount = Number(productMap.get(productId)?.product_value || 0);
    const inserted = await tryInsert({ participant_id: pid, user_id: pid, project_id: projId, product_id: productId || null, purchase_proof_id: eligi.proofId || null, amount: productAmount, status: 'ELIGIBLE' });
    if (inserted) coveredSet.add(covKey);
  }
};

module.exports = { getEligiblePayouts, getPayoutBatches, createPayoutBatch, markBatchPaid, getMyPayouts, backfillEligiblePayouts };
