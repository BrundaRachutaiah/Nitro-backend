const supabase = require('../config/supabaseClient');
const env = require('../config/env');
const {
  buildDateRange,
  applyDateFilter
} = require('../utils/date.utils');
const { ALLOCATION_STATUS } = require('../utils/constants');
const { Parser } = require('json2csv');
const { sendEmail } = require('../services/email.service');
const { logActivity } = require('../services/activityLog.service');
const { calculatePayoutBreakdown } = require('../utils/payout.utils');
const { ensureParticipantDetailsFromRegistration } = require('../services/participantDetails.service');
const {
  approvalEmail,
  rejectionEmail,
  productDecisionEmail
} = require('../services/email.templates');

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

const normalizeStatus = (value) => String(value || '').trim().toUpperCase();

const toAmount = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};
const APPROVED_APPLICATION_STATUSES = ['APPROVED', 'PURCHASED', 'COMPLETED'];
const DECISION_SUMMARY_WINDOW_MS = 3 * 60 * 60 * 1000;
const hasProvidedNumber = (value) =>
  value !== undefined
  && value !== null
  && String(value).trim() !== '';

const getApplicationBudgetAmount = (row, productValueMap = new Map()) => {
  const allocated = toAmount(row?.allocated_budget);
  if (allocated > 0) return allocated;
  return toAmount(productValueMap.get(row?.product_id));
};

const getApprovedApplicationBreakdownMap = async ({ participantIds = [], projectIds = [] } = {}) => {
  if (!participantIds.length || !projectIds.length) return new Map();

  let appRes = await supabase
    .from('project_applications')
    .select('participant_id, project_id, product_id, allocated_budget, status, created_at')
    .in('participant_id', participantIds)
    .in('project_id', projectIds)
    .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED'])
    .order('created_at', { ascending: false });

  if (appRes.error && /created_at/i.test(String(appRes.error.message || ''))) {
    appRes = await supabase
      .from('project_applications')
      .select('participant_id, project_id, product_id, allocated_budget, status')
      .in('participant_id', participantIds)
      .in('project_id', projectIds)
      .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);
  }
  if (appRes.error) throw appRes.error;

  const latestAppByPair = new Map();
  for (const row of (appRes.data || [])) {
    const key = `${row.participant_id}::${row.project_id}`;
    if (!latestAppByPair.has(key)) latestAppByPair.set(key, row);
  }

  const appProjectIds = [...new Set(Array.from(latestAppByPair.values()).map((row) => row.project_id).filter(Boolean))];
  const productIds = [...new Set(Array.from(latestAppByPair.values()).map((row) => row.product_id).filter(Boolean))];

  const [projectsRes, productsRes] = await Promise.all([
    appProjectIds.length
      ? supabase.from('projects').select('id, reward').in('id', appProjectIds)
      : Promise.resolve({ data: [], error: null }),
    productIds.length
      ? supabase.from('project_products').select('id, product_value').in('id', productIds)
      : Promise.resolve({ data: [], error: null })
  ]);

  if (projectsRes.error) throw projectsRes.error;
  if (productsRes.error && !isMissingSchemaObjectError(productsRes.error)) throw productsRes.error;

  const projectRewardMap = new Map((projectsRes.data || []).map((row) => [row.id, toAmount(row.reward)]));
  const productValueMap = new Map((productsRes.data || []).map((row) => [row.id, toAmount(row.product_value)]));

  const breakdownMap = new Map();
  for (const [key, app] of latestAppByPair.entries()) {
    const rewardAmount = toAmount(projectRewardMap.get(app.project_id));
    // Use product_value as primary. allocated_budget only as fallback when product_value=0.
    const catalogueValue = toAmount(productValueMap.get(app.product_id));
    const productAmount = catalogueValue > 0
      ? catalogueValue
      : toAmount(app.allocated_budget);
    breakdownMap.set(key, {
      rewardAmount,
      productAmount,
      totalAmount: rewardAmount + productAmount
    });
  }

  return breakdownMap;
};

const fillParticipantIdentity = async (rows = []) => {
  return Promise.all(
    rows.map(async (row) => {
      if ((row?.full_name && row?.email) || !row?.id) {
        return row;
      }

      const { data: authData, error } = await supabase.auth.admin.getUserById(row.id);
      if (error || !authData?.user) {
        return row;
      }

      const authUser = authData.user;
      return {
        ...row,
        full_name: row.full_name || authUser.user_metadata?.full_name || authUser.user_metadata?.name || null,
        email: row.email || authUser.email || null
      };
    })
  );
};

const sendParticipantDecisionSummaryNotification = async ({
  participantId,
  projectId,
  projectTitle = null,
  preferredType = 'PRODUCT_APPLICATION_APPROVED',
  decisionAnchorAt = null
} = {}) => {
  if (!participantId || !projectId) return;

  // ── 1. Check for any still-PENDING applications for this participant+project ──
  // We only send the summary email once ALL products have been reviewed (none left pending)
  const { data: pendingApps } = await supabase
    .from('project_applications')
    .select('id')
    .eq('participant_id', participantId)
    .eq('project_id', projectId)
    .eq('status', 'PENDING')
    .limit(1);

  // If there are still pending items, skip sending — wait for admin to finish all reviews
  if (pendingApps && pendingApps.length > 0) return;

  // ── 2. Fetch all decided applications ────────────────────────────────────
  let appRes = await supabase
    .from('project_applications')
    .select('id, status, product_id, reviewed_at, created_at')
    .eq('participant_id', participantId)
    .eq('project_id', projectId)
    .in('status', ['APPROVED', 'REJECTED'])
    .order('reviewed_at', { ascending: false });

  if (appRes.error && /reviewed_at/i.test(String(appRes.error.message || ''))) {
    appRes = await supabase
      .from('project_applications')
      .select('id, status, product_id, created_at')
      .eq('participant_id', participantId)
      .eq('project_id', projectId)
      .in('status', ['APPROVED', 'REJECTED'])
      .order('created_at', { ascending: false });
  }
  if (appRes.error) throw appRes.error;

  const rows = appRes.data || [];
  if (!rows.length) return;

  // Keep the summary scoped to the latest review session so old decisions
  // from previous apply cycles are not included in the email.
  const parseMs = (value) => {
    if (!value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  };
  const reviewedRows = rows.filter((row) => parseMs(row.reviewed_at) !== null);
  const anchorCandidates = [
    parseMs(decisionAnchorAt),
    ...reviewedRows.map((row) => parseMs(row.reviewed_at))
  ].filter((value) => value !== null);
  const anchorMs = anchorCandidates.length ? Math.max(...anchorCandidates) : null;

  let decisionRows = rows;
  if (anchorMs !== null && reviewedRows.length) {
    const cutoffMs = anchorMs - DECISION_SUMMARY_WINDOW_MS;
    const filtered = rows.filter((row) => {
      const reviewedAtMs = parseMs(row.reviewed_at);
      return reviewedAtMs !== null && reviewedAtMs >= cutoffMs && reviewedAtMs <= anchorMs + 60 * 1000;
    });
    if (filtered.length) decisionRows = filtered;
  }

  // Keep only the latest decision per product
  const latestByProduct = new Map();
  for (const row of decisionRows) {
    if (!row.product_id) continue;
    if (!latestByProduct.has(row.product_id)) {
      latestByProduct.set(row.product_id, row);
    }
  }

  // ── 3. Fetch product details: name, image_url, product_url, product_value ──
  const productIds = [...latestByProduct.keys()];
  let productMap = new Map();
  if (productIds.length) {
    const { data: products, error: productsError } = await supabase
      .from('project_products')
      .select('id, name, image_url, product_url, product_value')
      .in('id', productIds);
    if (productsError && !isMissingSchemaObjectError(productsError)) throw productsError;
    productMap = new Map((products || []).map((row) => [row.id, row]));
  }

  // ── 4. Group into approved / rejected with full product details ──────────
  const approvedProducts = [];
  const rejectedProducts = [];
  const approvedNames = [];
  const rejectedNames = [];

  for (const row of latestByProduct.values()) {
    const product = productMap.get(row.product_id) || {};
    const name = product.name || row.product_id;
    const status = String(row.status || '').toUpperCase();

    if (status === 'APPROVED') {
      approvedProducts.push({
        name,
        image_url: product.image_url || null,
        product_url: product.product_url || null,
        product_value: product.product_value || null
      });
      approvedNames.push(name);
    } else if (status === 'REJECTED') {
      rejectedProducts.push({
        name,
        image_url: product.image_url || null
      });
      rejectedNames.push(name);
    }
  }

  const approvedText = approvedNames.length ? `Approved: ${approvedNames.join(', ')}` : null;
  const rejectedText = rejectedNames.length ? `Rejected: ${rejectedNames.join(', ')}` : null;
  const summaryText = [approvedText, rejectedText].filter(Boolean).join(' | ');
  if (!summaryText) return;

  // ── 5. Fetch participant profile ─────────────────────────────────────────
  const { data: participantProfile } = await supabase
    .from('profiles')
    .select('id, full_name, email')
    .eq('id', participantId)
    .maybeSingle();

  // ── 6. Insert notification ───────────────────────────────────────────────
  const decisionDigest = Array.from(latestByProduct.values())
    .sort((a, b) => String(a.product_id).localeCompare(String(b.product_id)))
    .map((row) => `${row.product_id}:${normalizeStatus(row.status)}`)
    .join('|');
  const notificationMessage = `${projectTitle || 'Project'}: ${summaryText} [${decisionDigest}]`;

  const { data: existingNotification } = await supabase
    .from('notifications')
    .select('id')
    .eq('user_id', participantId)
    .eq('title', 'Product request update')
    .eq('message', notificationMessage)
    .limit(1)
    .maybeSingle();

  if (existingNotification?.id) return;

  await supabase
    .from('notifications')
    .insert({
      user_id: participantId,
      type: preferredType,
      title: 'Product request update',
      message: notificationMessage
    });

  // ── 7. Send beautifully designed grouped HTML email ──────────────────────
  if (participantProfile?.email) {
    const { productDecisionEmail } = require('../services/email.templates');

    const subjectLine = approvedProducts.length > 0 && rejectedProducts.length === 0
      ? `🎉 Product Request Approved — ${projectTitle || 'Nitro'}`
      : approvedProducts.length > 0
      ? `📋 Your Product Request Update — ${projectTitle || 'Nitro'}`
      : `📋 Product Request Update — ${projectTitle || 'Nitro'}`;

    const participantBaseUrl = `${env.frontendUrl.replace(/\/$/, '')}/participant/${participantId}`;
    const invoiceUrl = `${participantBaseUrl}/allocation/active`;
    const reviewUrl  = `${participantBaseUrl}/allocation/active`;

    await sendEmail({
      to: participantProfile.email,
      subject: subjectLine,
      html: productDecisionEmail(
        participantProfile.full_name,
        projectTitle || 'Project',
        approvedProducts,
        rejectedProducts,
        invoiceUrl,
        invoiceUrl,
        reviewUrl
      )
    });
  }
};

/**
 * Get all pending participants
 */
const getPendingParticipants = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, status, created_at')
      .eq('role', 'PARTICIPANT')
      .eq('status', 'PENDING');

    if (error) throw error;

    const enriched = await fillParticipantIdentity(data || []);
    res.json({ success: true, data: enriched });
  } catch (err) {
    next(err);
  }
};

/**
 * Approve participant
 */
const approveParticipant = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('profiles')
      .update({ status: 'APPROVED' })
      .eq('id', id)
      .eq('role', 'PARTICIPANT')
      .eq('status', 'PENDING')
      .select('id, full_name, email')
      .maybeSingle();

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Participant not found or already processed'
      });
    }

    if (error) throw error;

    res.json({
      success: true,
      message: 'Participant approved successfully'
    });

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PARTICIPANT_APPROVED',
      entityType: 'PROFILE',
      entityId: id,
      message: `Participant ${data.full_name || data.email || id} approved`
    });

    try {
      await ensureParticipantDetailsFromRegistration(id);
    } catch (detailsError) {
      console.error('[approveParticipant] Failed to backfill participant_details from registration metadata:', {
        participantId: id,
        error: detailsError?.message || String(detailsError)
      });
    }

    if (data?.email) {
      const loginUrl = `${env.frontendUrl.replace(/\/$/, '')}/login/participant`;
      const emailResult = await sendEmail({
        to: data.email,
        subject: '🎉 Your Nitro Account Has Been Approved',
        html: approvalEmail(data.full_name, loginUrl)
      });

      if (!emailResult?.success) {
        console.error('[approveParticipant] Approval email failed for participant:', {
          participantId: id,
          email: data.email,
          error: emailResult?.error?.message || emailResult?.error || 'Unknown email error'
        });
      }
    }
  } catch (err) {
    next(err);
  }
};

/**
 * Reject participant
 */
const rejectParticipant = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('profiles')
      .update({ status: 'REJECTED' })
      .eq('id', id)
      .eq('role', 'PARTICIPANT')
      .in('status', ['PENDING', 'APPROVED'])
      .select('id, full_name, email')
      .maybeSingle();

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Participant not found or already processed'
      });
    }

    if (error) throw error;

    res.json({
      success: true,
      message: 'Participant rejected'
    });

    if (data?.email) {
      const emailResult = await sendEmail({
        to: data.email,
        subject: 'Update on Your Nitro Application',
        html: rejectionEmail(data.full_name)
      });

      if (!emailResult?.success) {
        console.error('[rejectParticipant] Rejection email failed for participant:', {
          participantId: id,
          email: data.email,
          error: emailResult?.error?.message || emailResult?.error || 'Unknown email error'
        });
      }
    }

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PARTICIPANT_REJECTED',
      entityType: 'PROFILE',
      entityId: id,
      message: `Participant ${id} rejected`
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Remove participant (Super Admin)
 */
const deleteParticipant = async (req, res, next) => {
  try {
    if (req.user?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only Super Admin can delete participants'
      });
    }

    const { id } = req.params;

    const { data: participant, error: participantError } = await supabase
      .from('profiles')
      .select('id, role, status')
      .eq('id', id)
      .eq('role', 'PARTICIPANT')
      .maybeSingle();

    if (participantError) throw participantError;
    if (!participant) {
      return res.status(404).json({
        success: false,
        message: 'Participant not found'
      });
    }

    if (participant.status !== 'REJECTED') {
      return res.status(400).json({
        success: false,
        message: 'Reject participant before deleting'
      });
    }

    const { error: deleteError } = await supabase
      .from('profiles')
      .update({ status: 'DELETED' })
      .eq('id', id)
      .eq('role', 'PARTICIPANT');

    if (deleteError) throw deleteError;

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PARTICIPANT_DELETED',
      entityType: 'PROFILE',
      entityId: id,
      message: `Participant ${id} deleted`
    });

    return res.json({
      success: true,
      message: 'Participant deleted successfully'
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Promote participant to admin (Super Admin only)
 */
const promoteParticipantToAdmin = async (req, res, next) => {
  try {
    if (req.user?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only Super Admin can promote users to Admin'
      });
    }

    const { id } = req.params;

    const { data, error } = await supabase
      .from('profiles')
      .update({ role: 'ADMIN', status: 'APPROVED' })
      .eq('id', id)
      .eq('role', 'PARTICIPANT')
      .select('id, full_name, email, role, status')
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Participant not found or already promoted'
      });
    }

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PARTICIPANT_PROMOTED_TO_ADMIN',
      entityType: 'PROFILE',
      entityId: id,
      message: `Participant ${data.full_name || data.email || id} promoted to Admin`
    });

    return res.json({
      success: true,
      message: 'Participant promoted to Admin successfully',
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Remove admin access (Super Admin)
 */
const removeAdminAccess = async (req, res, next) => {
  try {
    if (req.user?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Only Super Admin can remove admin access'
      });
    }

    const { id } = req.params;

    if (id === req.user.id) {
      return res.status(400).json({
        success: false,
        message: 'You cannot remove your own admin access'
      });
    }

    const { data, error } = await supabase
      .from('profiles')
      .update({ role: 'PARTICIPANT', status: 'APPROVED' })
      .eq('id', id)
      .eq('role', 'ADMIN')
      .select('id, role, status')
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found or already removed'
      });
    }

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'ADMIN_ACCESS_REMOVED',
      entityType: 'PROFILE',
      entityId: id,
      message: `Admin access removed for ${id}`
    });

    return res.json({
      success: true,
      message: 'Admin access removed successfully',
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get all participants (Admin)
 */
const getAllParticipants = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, status, created_at')
      .eq('role', 'PARTICIPANT')
      .neq('status', 'DELETED')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const enriched = await fillParticipantIdentity(data || []);
    res.json({ success: true, data: enriched });
  } catch (err) {
    next(err);
  }
};

/**
 * Get all admins (Super Admin)
 */
const getAllAdmins = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, status, created_at')
      .eq('role', 'ADMIN')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const enriched = await fillParticipantIdentity(data || []);
    res.json({ success: true, data: enriched });
  } catch (err) {
    next(err);
  }
};

/**
 * Get participant by ID (Admin)
 */
const getParticipantById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', id)
      .eq('role', 'PARTICIPANT')
      .maybeSingle();

    if (profileError) throw profileError;

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: 'Participant not found'
      });
    }

    const { data: participantDetails, error: participantDetailsError } = await supabase
      .from('participant_details')
      .select('*')
      .eq('participant_id', id)
      .maybeSingle();

    if (participantDetailsError && !/does not exist|relation|schema cache|table|column/i.test(String(participantDetailsError.message || ''))) {
      throw participantDetailsError;
    }

    let applicationRes = await supabase
      .from('project_applications')
      .select(
        `
        id,
        project_id,
        product_id,
        status,
        allocated_budget,
        created_at,
        reviewed_at,
        projects (
          id,
          title,
          name,
          mode,
          reward
        ),
        project_products (
          id,
          name,
          product_value,
          product_url
        )
      `
      )
      .eq('participant_id', id)
      .order('created_at', { ascending: false });

    if (applicationRes.error && /created_at/i.test(String(applicationRes.error.message || ''))) {
      applicationRes = await supabase
        .from('project_applications')
        .select(
          `
          id,
          project_id,
          product_id,
          status,
          allocated_budget,
          reviewed_at,
          projects (
            id,
            title,
            name,
            mode,
            reward
          ),
          project_products (
            id,
            name,
            product_value,
            product_url
          )
        `
        )
        .eq('participant_id', id);
    }
    if (applicationRes.error && /project_products|relationship|schema cache|does not exist/i.test(String(applicationRes.error.message || ''))) {
      applicationRes = await supabase
        .from('project_applications')
        .select(
          `
          id,
          project_id,
          product_id,
          status,
          allocated_budget,
          created_at,
          reviewed_at,
          projects (
            id,
            title,
            name,
            mode,
            reward
          )
        `
        )
        .eq('participant_id', id)
        .order('created_at', { ascending: false });
    }
    if (applicationRes.error) throw applicationRes.error;

    let allocationRes = await supabase
      .from('unit_allocations')
      .select('id, project_id, status, reserved_until, completed_at, created_at')
      .eq('participant_id', id)
      .order('created_at', { ascending: false });

    if (allocationRes.error && /completed_at/i.test(String(allocationRes.error.message || ''))) {
      allocationRes = await supabase
        .from('unit_allocations')
        .select('id, project_id, status, reserved_until, created_at')
        .eq('participant_id', id)
        .order('created_at', { ascending: false });
    }

    if (allocationRes.error && /created_at/i.test(String(allocationRes.error.message || ''))) {
      allocationRes = await supabase
        .from('unit_allocations')
        .select('id, project_id, status, reserved_until, completed_at')
        .eq('participant_id', id)
        .order('reserved_until', { ascending: false });
    }

    if (allocationRes.error && /completed_at/i.test(String(allocationRes.error.message || ''))) {
      allocationRes = await supabase
        .from('unit_allocations')
        .select('id, project_id, status, reserved_until')
        .eq('participant_id', id)
        .order('reserved_until', { ascending: false });
    }
    if (allocationRes.error) throw allocationRes.error;

    let proofsRes = await supabase
      .from('purchase_proofs')
      .select('id, allocation_id, participant_id, status, file_url, created_at, uploaded_at')
      .eq('participant_id', id)
      .order('uploaded_at', { ascending: false });

    if (proofsRes.error && /created_at/i.test(String(proofsRes.error.message || ''))) {
      proofsRes = await supabase
        .from('purchase_proofs')
        .select('id, allocation_id, participant_id, status, file_url, uploaded_at')
        .eq('participant_id', id)
        .order('uploaded_at', { ascending: false });
    }
    if (proofsRes.error) throw proofsRes.error;

    const { data: reviews, error: reviewsError } = await supabase
      .from('participant_reviews')
      .select('id, allocation_id, participant_id, project_id, status, review_text, review_url, created_at')
      .eq('participant_id', id)
      .order('created_at', { ascending: false });
    if (reviewsError) throw reviewsError;

    const { data: payouts, error: payoutsError } = await supabase
      .from('payouts')
      .select('id, participant_id, project_id, payout_batch_id, amount, status, created_at')
      .eq('participant_id', id)
      .order('created_at', { ascending: false });
    if (payoutsError) throw payoutsError;

    let applications = applicationRes.data || [];
    const allocations = allocationRes.data || [];
    const proofs = proofsRes.data || [];
    const reviewRows = reviews || [];
    const payoutRows = payouts || [];

    const missingProductRel = applications.some((row) => row.product_id && !row.project_products);
    if (missingProductRel) {
      const productIds = [...new Set(applications.map((row) => row.product_id).filter(Boolean))];
      if (productIds.length) {
        const { data: productRows, error: productError } = await supabase
          .from('project_products')
          .select('id, name, product_value, product_url')
          .in('id', productIds);
        if (!productError) {
          const productMap = new Map((productRows || []).map((row) => [row.id, row]));
          applications = applications.map((row) => ({
            ...row,
            project_products: row.project_products || productMap.get(row.product_id) || null
          }));
        }
      }
    }

    const allocationsByProject = new Map();
    for (const row of allocations) {
      if (!allocationsByProject.has(row.project_id)) {
        allocationsByProject.set(row.project_id, row);
      }
    }

    const proofsByAllocation = new Map();
    for (const row of proofs) {
      if (!proofsByAllocation.has(row.allocation_id)) {
        proofsByAllocation.set(row.allocation_id, row);
      }
    }

    const reviewsByAllocation = new Map();
    for (const row of reviewRows) {
      if (!reviewsByAllocation.has(row.allocation_id)) {
        reviewsByAllocation.set(row.allocation_id, row);
      }
    }

    const reviewsByProject = new Map();
    for (const row of reviewRows) {
      if (row.project_id && !reviewsByProject.has(row.project_id)) {
        reviewsByProject.set(row.project_id, row);
      }
    }

    const payoutsByProject = new Map();
    for (const row of payoutRows) {
      if (row.project_id && !payoutsByProject.has(row.project_id)) {
        payoutsByProject.set(row.project_id, row);
      }
    }

    const completedProducts = applications
      .filter((app) => ['APPROVED', 'PURCHASED', 'COMPLETED'].includes(String(app.status || '').toUpperCase()))
      .map((app) => {
        const allocation = allocationsByProject.get(app.project_id) || null;
        const proof = allocation ? proofsByAllocation.get(allocation.id) || null : null;
        const review = (allocation ? reviewsByAllocation.get(allocation.id) : null)
          || reviewsByProject.get(app.project_id)
          || null;
        const payout = payoutsByProject.get(app.project_id) || null;

        const projectName = app?.projects?.title || app?.projects?.name || '-';
        const productName = app?.project_products?.name || '-';
        const rewardAmount = Number(app?.projects?.reward || 0);
        const allocatedBudget = Number(app?.allocated_budget || app?.project_products?.product_value || 0);
        const totalPayout = rewardAmount + allocatedBudget;

        return {
          application_id: app.id,
          project_id: app.project_id,
          project_name: projectName,
          project_mode: app?.projects?.mode || null,
          product_id: app.product_id,
          product_name: productName,
          reward_amount: rewardAmount,
          product_amount: allocatedBudget,
          expected_payout_amount: totalPayout,
          allocation_id: allocation?.id || null,
          allocation_status: allocation?.status || null,
          reserved_until: allocation?.reserved_until || null,
          completed_at: allocation?.completed_at || null,
          purchase_proof_status: proof?.status || null,
          purchase_proof_url: proof?.file_url || null,
          proof_uploaded_at: proof?.uploaded_at || proof?.created_at || null,
          review_status: review?.status || null,
          review_url: review?.review_url || null,
          review_text: review?.review_text || null,
          review_submitted_at: review?.created_at || null,
          payout_status: payout?.status || null,
          payout_amount: Number(payout?.amount || 0),
          payout_batch_id: payout?.payout_batch_id || null,
          payout_created_at: payout?.created_at || null
        };
      });

    const summary = {
      approved_applications: applications.filter((row) => String(row.status || '').toUpperCase() === 'APPROVED').length,
      allocated_projects: allocations.length,
      approved_purchase_proofs: proofs.filter((row) => String(row.status || '').toUpperCase() === 'APPROVED').length,
      approved_reviews: reviewRows.filter((row) => String(row.status || '').toUpperCase() === 'APPROVED').length,
      payouts_eligible: payoutRows.filter((row) => String(row.status || '').toUpperCase() === 'ELIGIBLE').length,
      payouts_in_batch: payoutRows.filter((row) => ['IN_BATCH', 'EXPORTED'].includes(String(row.status || '').toUpperCase())).length,
      payouts_paid: payoutRows.filter((row) => String(row.status || '').toUpperCase() === 'PAID').length
    };

    res.json({
      success: true,
      data: {
        ...profile,
        ...(participantDetails || {}),
        summary,
        completed_products: completedProducts
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Admin dashboard summary
 */
const getAdminDashboardSummary = async (req, res, next) => {
  try {
    const range = buildDateRange(req.query);

    let participantsQuery = supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'PARTICIPANT');

    participantsQuery = applyDateFilter(participantsQuery, range);
    const participantsTotal = await participantsQuery;

    let approvedQuery = supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'PARTICIPANT')
      .eq('status', 'APPROVED');

    approvedQuery = applyDateFilter(approvedQuery, range);
    const participantsApproved = await approvedQuery;

    let projectsQuery = supabase
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'published');

    projectsQuery = applyDateFilter(projectsQuery, range);
    const projectsActive = await projectsQuery;

    let proofsQuery = supabase
      .from('purchase_proofs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'PENDING');

    proofsQuery = applyDateFilter(proofsQuery, range);
    const purchaseProofsPending = await proofsQuery;

    let payoutsQuery = supabase
      .from('payout_batches')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'PENDING');

    payoutsQuery = applyDateFilter(payoutsQuery, range);
    const payoutsPending = await payoutsQuery;

    const { count: payoutsEligible } = await supabase
      .from('payouts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'ELIGIBLE');

    res.json({
      success: true,
      data: {
        participants_total: participantsTotal.count || 0,
        participants_approved: participantsApproved.count || 0,
        projects_active: projectsActive.count || 0,
        purchase_proofs_pending: purchaseProofsPending.count || 0,
        payouts_pending: payoutsPending.count || 0,
        payouts_eligible: payoutsEligible || 0
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Dashboard summary (shared)
 */
const getDashboardSummary = async (req, res, next) => {
  try {
    const range = buildDateRange(req.query);

    let participantsQuery = supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'PARTICIPANT');

    participantsQuery = applyDateFilter(participantsQuery, range);
    const participantsTotal = await participantsQuery;

    let approvedQuery = supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'PARTICIPANT')
      .eq('status', 'APPROVED');

    approvedQuery = applyDateFilter(approvedQuery, range);
    const participantsApproved = await approvedQuery;

    let projectsQuery = supabase
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'published');

    projectsQuery = applyDateFilter(projectsQuery, range);
    const projectsActive = await projectsQuery;

    let proofsQuery = supabase
      .from('purchase_proofs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'PENDING');

    proofsQuery = applyDateFilter(proofsQuery, range);
    const purchaseProofsPending = await proofsQuery;

    let payoutsQuery = supabase
      .from('payout_batches')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'PENDING');

    payoutsQuery = applyDateFilter(payoutsQuery, range);
    const payoutsPending = await payoutsQuery;

    const { count: payoutsEligible } = await supabase
      .from('payouts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'ELIGIBLE');

    res.json({
      success: true,
      data: {
        participants_total: participantsTotal.count || 0,
        participants_approved: participantsApproved.count || 0,
        projects_active: projectsActive.count || 0,
        purchase_proofs_pending: purchaseProofsPending.count || 0,
        payouts_pending: payoutsPending.count || 0,
        payouts_eligible: payoutsEligible || 0
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Admin activity
 */
const getAdminActivity = async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 20;

    const { data, error } = await supabase
      .from('activity_logs')
      .select(
        `
        id,
        actor_id,
        actor_role,
        action,
        entity_type,
        entity_id,
        message,
        created_at
      `
      )
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    if (Array.isArray(data) && data.length > 0) {
      return res.json({
        success: true,
        data
      });
    }

    // Fallback: synthesize recent activity from existing domain tables
    const fallbackActivities = [];

    const { data: participants } = await supabase
      .from('profiles')
      .select('id, full_name, status, created_at')
      .eq('role', 'PARTICIPANT')
      .order('created_at', { ascending: false })
      .limit(limit);

    (participants || []).forEach((row) => {
      fallbackActivities.push({
        id: `profile-${row.id}`,
        action: 'PARTICIPANT_REGISTERED',
        entity_type: 'PROFILE',
        message: `${row.full_name || row.id} registered (${row.status || 'UNKNOWN'})`,
        created_at: row.created_at
      });
    });

    const accessRes = await supabase
      .from('project_access_requests')
      .select('id, status, created_at, participant_id, project_id')
      .order('created_at', { ascending: false })
      .limit(limit);

    const appRes = await supabase
      .from('project_applications')
      .select('id, status, created_at, participant_id, project_id, product_id')
      .order('created_at', { ascending: false })
      .limit(limit);
    const projectRes = await supabase
      .from('projects')
      .select('id, title, created_at, created_by')
      .order('created_at', { ascending: false })
      .limit(limit);

    const accessRows = !accessRes.error ? (accessRes.data || []) : [];
    const appRows = !appRes.error ? (appRes.data || []) : [];
    const projectRows = !projectRes.error ? (projectRes.data || []) : [];

    const participantIds = new Set();
    const projectIds = new Set();
    const productIds = new Set();
    const creatorIds = new Set();

    accessRows.forEach((row) => {
      if (row.participant_id) participantIds.add(row.participant_id);
      if (row.project_id) projectIds.add(row.project_id);
    });

    appRows.forEach((row) => {
      if (row.participant_id) participantIds.add(row.participant_id);
      if (row.project_id) projectIds.add(row.project_id);
      if (row.product_id) productIds.add(row.product_id);
    });

    projectRows.forEach((row) => {
      if (row.created_by) creatorIds.add(row.created_by);
      if (row.id) projectIds.add(row.id);
    });

    const allProfileIds = [...new Set([...participantIds, ...creatorIds])];
    let profileMap = new Map();
    if (allProfileIds.length) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', allProfileIds);
      profileMap = new Map(
        (profiles || []).map((row) => [row.id, row.full_name || row.email || row.id])
      );
    }

    let projectMap = new Map();
    if (projectIds.size) {
      const { data: projects } = await supabase
        .from('projects')
        .select('id, title')
        .in('id', [...projectIds]);
      projectMap = new Map(
        (projects || []).map((row) => [row.id, row.title || row.id])
      );
    }

    let productMap = new Map();
    if (productIds.size) {
      const { data: products } = await supabase
        .from('project_products')
        .select('id, name')
        .in('id', [...productIds]);
      productMap = new Map(
        (products || []).map((row) => [row.id, row.name || row.id])
      );
    }

    accessRows.forEach((row) => {
      const participantLabel = profileMap.get(row.participant_id) || row.participant_id || 'Participant';
      const projectLabel = projectMap.get(row.project_id) || row.project_id || 'Project';
      fallbackActivities.push({
        id: `unlock-${row.id}`,
        action: `PROJECT_ACCESS_${String(row.status || 'PENDING').toUpperCase()}`,
        entity_type: 'PROJECT_ACCESS_REQUEST',
        message: `${participantLabel} requested unlock for ${projectLabel} (${String(row.status || 'PENDING').toUpperCase()})`,
        created_at: row.created_at
      });
    });

    appRows.forEach((row) => {
      const participantLabel = profileMap.get(row.participant_id) || row.participant_id || 'Participant';
      const projectLabel = projectMap.get(row.project_id) || row.project_id || 'Project';
      const productLabel = productMap.get(row.product_id) || row.product_id || 'Product';
      fallbackActivities.push({
        id: `app-${row.id}`,
        action: `PRODUCT_APPLICATION_${String(row.status || 'PENDING').toUpperCase()}`,
        entity_type: 'PROJECT_APPLICATION',
        message: `${participantLabel} applied for ${productLabel} in ${projectLabel} (${String(row.status || 'PENDING').toUpperCase()})`,
        created_at: row.created_at
      });
    });

    projectRows.forEach((row) => {
      const creatorLabel = profileMap.get(row.created_by) || row.created_by || 'Admin';
      fallbackActivities.push({
        id: `project-${row.id}`,
        action: 'PROJECT_CREATED',
        entity_type: 'PROJECT',
        message: `${creatorLabel} created project ${row.title || row.id}`,
        created_at: row.created_at
      });
    });

    fallbackActivities.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    res.json({
      success: true,
      data: fallbackActivities.slice(0, limit)
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Approvals count
 */
const getApprovalsCount = async (req, res, next) => {
  try {
    const [participants, purchaseProofs, pendingReviews, payouts, projectAccessRequests, productApplications] = await Promise.all([
      supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'PARTICIPANT')
        .eq('status', 'PENDING'),

      supabase
        .from('purchase_proofs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'PENDING'),

      supabase
        .from('participant_reviews')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'PENDING'),

      supabase
        .from('payout_batches')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'PENDING'),

      supabase
        .from('project_access_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'PENDING'),

      supabase
        .from('project_applications')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'PENDING')
    ]);

    const data = {
      participants: participants.count || 0,
      purchase_proofs: purchaseProofs.count || 0,
      review_submissions: pendingReviews.count || 0,
      payouts: payouts.count || 0,
      project_access_requests: projectAccessRequests.count || 0,
      product_applications: productApplications.count || 0
    };

    res.json({
      success: true,
      data: {
        ...data,
        total:
          data.participants
          + data.project_access_requests
          + data.product_applications
          + data.purchase_proofs
          + data.review_submissions
          + data.payouts
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Approvals list
 */
const getApprovals = async (req, res, next) => {
  try {
    const [participants, proofs, pendingReviews, payouts] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, full_name, created_at')
        .eq('role', 'PARTICIPANT')
        .eq('status', 'PENDING'),

      supabase
        .from('purchase_proofs')
        .select('id, allocation_id, created_at')
        .eq('status', 'PENDING'),

      supabase
        .from('participant_reviews')
        .select('id, allocation_id, created_at')
        .eq('status', 'PENDING'),

      supabase
        .from('payout_batches')
        .select('id, created_at')
        .eq('status', 'PENDING')
    ]);

    const approvals = [
      ...(participants.data || []).map(p => ({
        type: 'participant',
        id: p.id,
        name: p.full_name,
        created_at: p.created_at
      })),
      ...(proofs.data || []).map(p => ({
        type: 'purchase_proof',
        id: p.id,
        allocation_id: p.allocation_id,
        created_at: p.created_at
      })),
      ...(pendingReviews.data || []).map((review) => ({
        type: 'review_submission',
        id: review.id,
        allocation_id: review.allocation_id,
        created_at: review.created_at
      })),
      ...(payouts.data || []).map(p => ({
        type: 'payout',
        id: p.id,
        created_at: p.created_at
      }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({
      success: true,
      data: approvals
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Admin search
 */
const adminSearch = async (req, res, next) => {
  try {
    const q = req.query.q?.trim();

    if (!q) {
      return res.json({
        success: true,
        data: {
          participants: [],
          projects: [],
          applications: []
        }
      });
    }

    const searchTerm = `%${q}%`;

    const [participants, projects, applications] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, full_name, email, status')
        .eq('role', 'PARTICIPANT')
        .ilike('full_name', searchTerm)
        .limit(10),

      supabase
        .from('projects')
        .select('id, title, status')
        .ilike('title', searchTerm)
        .limit(10),

      supabase
        .from('project_applications')
        .select('id, project_id, participant_id, status')
        .ilike('status', searchTerm)
        .limit(10)
    ]);

    res.json({
      success: true,
      data: {
        participants: participants.data || [],
        projects: projects.data || [],
        applications: applications.data || []
      }
    });
  } catch (err) {
    next(err);
  }
};

const getApplicationSummary = async (req, res, next) => {
  try {
    const toIsoOrNull = (value) => {
      if (!value) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    };

    const getLatest = (rows, field, predicate = () => true) => {
      const values = rows
        .filter(predicate)
        .map((row) => toIsoOrNull(row?.[field]))
        .filter(Boolean)
        .sort((a, b) => new Date(b) - new Date(a));
      return values[0] || null;
    };

    let participantRows = [];
    const participantQuery = await supabase
      .from('profiles')
      .select('status, created_at, updated_at')
      .eq('role', 'PARTICIPANT');

    if (participantQuery.error) {
      const fallback = await supabase
        .from('profiles')
        .select('status, created_at')
        .eq('role', 'PARTICIPANT');
      if (fallback.error) throw fallback.error;
      participantRows = fallback.data || [];
    } else {
      participantRows = participantQuery.data || [];
    }

    const { data: accessRows, error: accessError } = await supabase
      .from('project_access_requests')
      .select('status, created_at, reviewed_at');
    if (accessError) throw accessError;

    const { data: applicationRows, error: applicationError } = await supabase
      .from('project_applications')
      .select('status, created_at, reviewed_at');
    if (applicationError) throw applicationError;

    let purchaseProofRows = [];
    let purchaseProofRes = await supabase
      .from('purchase_proofs')
      .select('status, created_at, uploaded_at');

    if (purchaseProofRes.error && /created_at/i.test(String(purchaseProofRes.error.message || ''))) {
      purchaseProofRes = await supabase
        .from('purchase_proofs')
        .select('status, uploaded_at');
    }

    if (purchaseProofRes.error) throw purchaseProofRes.error;
    purchaseProofRows = purchaseProofRes.data || [];

    const { data: reviewRows, error: reviewError } = await supabase
      .from('participant_reviews')
      .select('status, created_at');
    if (reviewError) throw reviewError;

    const loginSummary = {
      pending_count: participantRows.filter((row) => row.status === 'PENDING').length,
      total_requested: participantRows.length,
      approved_count: participantRows.filter((row) => row.status === 'APPROVED').length,
      rejected_count: participantRows.filter((row) => row.status === 'REJECTED').length,
      last_requested_at: getLatest(participantRows, 'created_at'),
      last_approved_at: getLatest(
        participantRows,
        participantRows.some((row) => row.updated_at) ? 'updated_at' : 'created_at',
        (row) => row.status === 'APPROVED'
      ),
      last_rejected_at: getLatest(
        participantRows,
        participantRows.some((row) => row.updated_at) ? 'updated_at' : 'created_at',
        (row) => row.status === 'REJECTED'
      )
    };

    const accessSummary = {
      pending_count: (accessRows || []).filter((row) => row.status === 'PENDING').length,
      total_requested: (accessRows || []).length,
      approved_count: (accessRows || []).filter((row) => row.status === 'APPROVED').length,
      rejected_count: (accessRows || []).filter((row) => row.status === 'REJECTED').length,
      last_requested_at: getLatest(accessRows || [], 'created_at'),
      last_approved_at: getLatest(accessRows || [], 'reviewed_at', (row) => row.status === 'APPROVED'),
      last_rejected_at: getLatest(accessRows || [], 'reviewed_at', (row) => row.status === 'REJECTED')
    };

    const productSummary = {
      pending_count: (applicationRows || []).filter((row) => row.status === 'PENDING').length,
      total_requested: (applicationRows || []).length,
      approved_count: (applicationRows || []).filter((row) => row.status === 'APPROVED').length,
      rejected_count: (applicationRows || []).filter((row) => row.status === 'REJECTED').length,
      last_requested_at: getLatest(applicationRows || [], 'created_at'),
      last_approved_at: getLatest(applicationRows || [], 'reviewed_at', (row) => row.status === 'APPROVED'),
      last_rejected_at: getLatest(applicationRows || [], 'reviewed_at', (row) => row.status === 'REJECTED')
    };

    const proofRowsNormalized = (purchaseProofRows || []).map((row) => ({
      ...row,
      created_at: row.created_at || row.uploaded_at || null
    }));

    const invoiceSummary = {
      pending_count: proofRowsNormalized.filter((row) => row.status === 'PENDING').length,
      total_requested: proofRowsNormalized.length,
      approved_count: proofRowsNormalized.filter((row) => row.status === 'APPROVED').length,
      rejected_count: proofRowsNormalized.filter((row) => row.status === 'REJECTED').length,
      last_requested_at: getLatest(proofRowsNormalized, 'created_at')
    };

    const reviewSummary = {
      pending_count: (reviewRows || []).filter((row) => row.status === 'PENDING').length,
      total_requested: (reviewRows || []).length,
      approved_count: (reviewRows || []).filter((row) => row.status === 'APPROVED').length,
      rejected_count: (reviewRows || []).filter((row) => row.status === 'REJECTED').length,
      last_requested_at: getLatest(reviewRows || [], 'created_at')
    };

    const finalSummary = {
      pending_total: loginSummary.pending_count + accessSummary.pending_count + productSummary.pending_count + invoiceSummary.pending_count + reviewSummary.pending_count,
      total_requested: loginSummary.total_requested + accessSummary.total_requested + productSummary.total_requested + invoiceSummary.total_requested + reviewSummary.total_requested,
      total_approved: loginSummary.approved_count + accessSummary.approved_count + productSummary.approved_count + invoiceSummary.approved_count + reviewSummary.approved_count,
      total_rejected: loginSummary.rejected_count + accessSummary.rejected_count + productSummary.rejected_count + invoiceSummary.rejected_count + reviewSummary.rejected_count
    };

    return res.json({
      success: true,
      data: {
        login_requests: loginSummary,
        project_unlock_requests: accessSummary,
        product_applications: productSummary,
        invoice_submissions: invoiceSummary,
        review_submissions: reviewSummary,
        final_summary: finalSummary
      }
    });
  } catch (err) {
    next(err);
  }
};

const getPendingProjectAccessRequests = async (req, res, next) => {
  try {
    const requestedStatus = String(req.query.status || 'PENDING').toUpperCase();
    const { data: requests, error } = await supabase
      .from('project_access_requests')
      .select(
        `
        id,
        project_id,
        participant_id,
        status,
        created_at
      `
      )
      .in('status', requestedStatus === 'ALL' ? ['PENDING', 'APPROVED', 'REJECTED'] : [requestedStatus])
      .order('created_at', { ascending: true });

    if (error) throw error;

    const projectIds = [...new Set((requests || []).map((row) => row.project_id).filter(Boolean))];
    const participantIds = [...new Set((requests || []).map((row) => row.participant_id).filter(Boolean))];

    let projects = [];
    if (projectIds.length) {
      const { data: projectRows, error: projectError } = await supabase
        .from('projects')
        .select('id, title, mode')
        .in('id', projectIds);
      if (projectError) throw projectError;
      projects = projectRows || [];
    }

    let profiles = [];
    if (participantIds.length) {
      const { data: profileRows, error: profileError } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', participantIds);
      if (profileError) throw profileError;
      profiles = profileRows || [];
    }

    const projectMap = new Map(projects.map((item) => [item.id, item]));
    const profileMap = new Map(profiles.map((item) => [item.id, item]));

    const data = (requests || []).map((row) => ({
      ...row,
      projects: projectMap.get(row.project_id) || null,
      profiles: profileMap.get(row.participant_id) || null
    }));

    res.json({
      success: true,
      data: data || []
    });
  } catch (err) {
    next(err);
  }
};

const approveProjectAccessRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const { data, error } = await supabase
      .from('project_access_requests')
      .update({
        status: 'APPROVED',
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
        notes: notes || null
      })
      .eq('id', id)
      .eq('status', 'PENDING')
      .select('id, participant_id, project_id')
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Project access request not found or already processed'
      });
    }

    await supabase
      .from('notifications')
      .insert({
        user_id: data.participant_id,
        type: 'PROJECT_ACCESS_APPROVED',
        title: 'Project unlocked',
        message: 'Your project access request has been approved. You can now view products.'
      });

    res.json({
      success: true,
      message: 'Project access approved'
    });

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PROJECT_ACCESS_APPROVED',
      entityType: 'PROJECT_ACCESS_REQUEST',
      entityId: id,
      message: `Project access request ${id} approved`
    });
  } catch (err) {
    next(err);
  }
};

const rejectProjectAccessRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const { data, error } = await supabase
      .from('project_access_requests')
      .update({
        status: 'REJECTED',
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
        notes: notes || null
      })
      .eq('id', id)
      .eq('status', 'PENDING')
      .select('id, participant_id')
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Project access request not found or already processed'
      });
    }

    await supabase
      .from('notifications')
      .insert({
        user_id: data.participant_id,
        type: 'PROJECT_ACCESS_REJECTED',
        title: 'Project request rejected',
        message: 'Your project access request was rejected by admin.'
      });

    res.json({
      success: true,
      message: 'Project access rejected'
    });

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PROJECT_ACCESS_REJECTED',
      entityType: 'PROJECT_ACCESS_REQUEST',
      entityId: id,
      message: `Project access request ${id} rejected`
    });
  } catch (err) {
    next(err);
  }
};

const getPendingProductApplications = async (req, res, next) => {
  try {
    const requestedStatus = String(req.query.status || 'PENDING').toUpperCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data: applications, count, error } = await supabase
      .from('project_applications')
      .select(
      `
        id,
        project_id,
        participant_id,
        product_id,
        allocated_budget,
        status,
        created_at
      `,
      { count: 'exact' }
      )
      .in('status', requestedStatus === 'ALL' ? ['PENDING', 'APPROVED', 'REJECTED'] : [requestedStatus])
      .order('created_at', { ascending: true })
      .range(from, to);

    if (error) throw error;

    const projectIds = [...new Set((applications || []).map((row) => row.project_id).filter(Boolean))];
    const participantIds = [...new Set((applications || []).map((row) => row.participant_id).filter(Boolean))];
    const productIds = [...new Set((applications || []).map((row) => row.product_id).filter(Boolean))];

    let projects = [];
    if (projectIds.length) {
      const { data: projectRows, error: projectError } = await supabase
        .from('projects')
        .select('id, title, mode, reward, created_by')
        .in('id', projectIds);
      if (projectError) throw projectError;
      projects = projectRows || [];
    }

    let profiles = [];
    if (participantIds.length) {
      const { data: profileRows, error: profileError } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', participantIds);
      if (profileError) throw profileError;
      profiles = profileRows || [];
    }

    const { data: approvedRows, error: approvedError } = projectIds.length
      ? await supabase
          .from('project_applications')
          .select('id, project_id, product_id, allocated_budget, status')
          .in('project_id', projectIds)
          .in('status', APPROVED_APPLICATION_STATUSES)
      : { data: [], error: null };
    if (approvedError) throw approvedError;

    const approvedProductIds = [
      ...new Set((approvedRows || []).map((row) => row.product_id).filter(Boolean))
    ];
    const allProductIds = [...new Set([...productIds, ...approvedProductIds])];

    let projectProducts = [];
    if (allProductIds.length) {
      const { data: productRows, error: productError } = await supabase
        .from('project_products')
        .select('id, name, product_url, product_value')
        .in('id', allProductIds);
      if (productError) throw productError;
      projectProducts = productRows || [];
    }

    const projectMap = new Map(projects.map((item) => [item.id, item]));
    const profileMap = new Map(profiles.map((item) => [item.id, item]));
    const productMap = new Map(projectProducts.map((item) => [item.id, item]));
    const productValueMap = new Map(projectProducts.map((item) => [item.id, toAmount(item.product_value)]));

    const approvedSpendByProject = new Map();
    for (const row of (approvedRows || [])) {
      const amount = getApplicationBudgetAmount(row, productValueMap);
      if (!row.project_id || amount <= 0) continue;
      approvedSpendByProject.set(
        row.project_id,
        toAmount(approvedSpendByProject.get(row.project_id)) + amount
      );
    }

    const data = (applications || []).map((row) => {
      const project = projectMap.get(row.project_id) || null;
      const product = productMap.get(row.product_id) || null;
      const projectBudget = toAmount(project?.reward);
      const spentBudget = toAmount(approvedSpendByProject.get(row.project_id));
      const remainingBudget = Math.max(0, projectBudget - spentBudget);
      const requestedAmount = getApplicationBudgetAmount(row, productValueMap);

      return {
        ...row,
        projects: project,
        profiles: profileMap.get(row.participant_id) || null,
        project_products: product,
        requested_amount: requestedAmount,
        suggested_allocated_budget: requestedAmount,
        project_budget: projectBudget,
        project_spent_budget: spentBudget,
        project_remaining_budget: remainingBudget,
        can_approve: String(row.status || '').toUpperCase() === 'PENDING'
          ? requestedAmount <= remainingBudget
          : null
      };
    });

    const groupedMap = new Map();
    for (const row of data) {
      const key = `${row.participant_id || ''}::${row.project_id || ''}`;
      if (!groupedMap.has(key)) {
        groupedMap.set(key, {
          key,
          participant_id: row.participant_id,
          participant_name: row?.profiles?.full_name || row.participant_id || '-',
          participant_email: row?.profiles?.email || '-',
          project_id: row.project_id,
          project_title: row?.projects?.title || row.project_id || '-',
          project_budget: row.project_budget,
          project_spent_budget: row.project_spent_budget,
          project_remaining_budget: row.project_remaining_budget,
          items: []
        });
      }
      groupedMap.get(key).items.push(row);
    }

    const groups = Array.from(groupedMap.values()).map((group) => ({
      ...group,
      row_span: group.items.length
    }));

    res.json({
      success: true,
      data: data || [],
      groups,
      meta: {
        page,
        limit,
        total: Number(count || 0),
        total_pages: Math.ceil(Number(count || 0) / limit)
      }
    });
  } catch (err) {
    next(err);
  }
};

const approveProductApplication = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { allocated_budget, eligibility_notes } = req.body;
    if (hasProvidedNumber(allocated_budget) && (!Number.isFinite(Number(allocated_budget)) || Number(allocated_budget) < 0)) {
      return res.status(400).json({
        success: false,
        message: 'allocated_budget must be a valid non-negative number'
      });
    }

    const { data: pendingApplication, error: pendingError } = await supabase
      .from('project_applications')
      .select('id, project_id, participant_id, product_id')
      .eq('id', id)
      .eq('status', 'PENDING')
      .maybeSingle();

    if (pendingError) throw pendingError;
    if (!pendingApplication) {
      return res.status(404).json({
        success: false,
        message: 'Application not found or already processed'
      });
    }

    const [{ data: projectRow, error: projectError }, { data: productRow, error: productError }] = await Promise.all([
      supabase
        .from('projects')
        .select('id, title, reward')
        .eq('id', pendingApplication.project_id)
        .maybeSingle(),
      pendingApplication.product_id
        ? supabase
            .from('project_products')
            .select('id, name, product_value')
            .eq('id', pendingApplication.product_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null })
    ]);
    if (projectError) throw projectError;
    if (productError && !/column|schema|does not exist|relation/i.test(String(productError.message || ''))) {
      throw productError;
    }

    const defaultAllocatedBudget = toAmount(productRow?.product_value);
    const normalizedAllocatedBudget = hasProvidedNumber(allocated_budget)
      ? Number(allocated_budget)
      : defaultAllocatedBudget;

    if (!Number.isFinite(normalizedAllocatedBudget) || normalizedAllocatedBudget <= 0) {
      return res.status(400).json({
        success: false,
        message: 'allocated_budget must be greater than 0'
      });
    }

    const { data: approvedRows, error: approvedError } = await supabase
      .from('project_applications')
      .select('id, project_id, product_id, allocated_budget, status')
      .eq('project_id', pendingApplication.project_id)
      .in('status', APPROVED_APPLICATION_STATUSES);
    if (approvedError) throw approvedError;

    const approvedProductIds = [
      ...new Set((approvedRows || []).map((row) => row.product_id).filter(Boolean))
    ];
    let approvedProducts = [];
    if (approvedProductIds.length) {
      const { data: productRows, error: approvedProductsError } = await supabase
        .from('project_products')
        .select('id, product_value')
        .in('id', approvedProductIds);
      if (approvedProductsError) throw approvedProductsError;
      approvedProducts = productRows || [];
    }

    const productValueMap = new Map(approvedProducts.map((row) => [row.id, toAmount(row.product_value)]));
    const alreadyAllocated = (approvedRows || []).reduce(
      (sum, row) => sum + getApplicationBudgetAmount(row, productValueMap),
      0
    );

    const projectBudget = toAmount(projectRow?.reward);
    const remainingBudgetBeforeApproval = Math.max(0, projectBudget - alreadyAllocated);
    if (normalizedAllocatedBudget > remainingBudgetBeforeApproval) {
      return res.status(400).json({
        success: false,
        message: `Allocated budget exceeds remaining project budget. Remaining: Rs ${remainingBudgetBeforeApproval}.`
      });
    }

    const { data: application, error } = await supabase
      .from('project_applications')
      .update({
        status: 'APPROVED',
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
        eligibility_notes: eligibility_notes || null,
        allocated_budget: normalizedAllocatedBudget
      })
      .eq('id', id)
      .eq('status', 'PENDING')
      .select('id, project_id, participant_id, reviewed_at')
      .maybeSingle();

    if (error) throw error;
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found or already processed'
      });
    }

    let allocationLookup = await supabase
      .from('unit_allocations')
      .select('id')
      .eq('participant_id', application.participant_id)
      .in('status', [ALLOCATION_STATUS.RESERVED, ALLOCATION_STATUS.PURCHASED])
      .is('completed_at', null)
      .limit(1)
      .maybeSingle();

    if (allocationLookup.error && /completed_at/i.test(String(allocationLookup.error.message || ''))) {
      allocationLookup = await supabase
        .from('unit_allocations')
        .select('id')
        .eq('participant_id', application.participant_id)
        .in('status', [ALLOCATION_STATUS.RESERVED, ALLOCATION_STATUS.PURCHASED])
        .limit(1)
        .maybeSingle();

      if (allocationLookup.error && /status/i.test(String(allocationLookup.error.message || ''))) {
        allocationLookup = await supabase
          .from('unit_allocations')
          .select('id')
          .eq('participant_id', application.participant_id)
          .limit(1)
          .maybeSingle();
      }
    }

    if (allocationLookup.error && !isMissingSchemaObjectError(allocationLookup.error)) {
      throw allocationLookup.error;
    }

    const existingAllocation = allocationLookup.data;

    if (!existingAllocation) {
      const reservedUntil = new Date();
      reservedUntil.setDate(reservedUntil.getDate() + 20);

      const { error: allocationError } = await supabase
        .from('unit_allocations')
        .insert({
          project_id: application.project_id,
          participant_id: application.participant_id,
          reserved_until: reservedUntil.toISOString(),
          status: ALLOCATION_STATUS.RESERVED
        });

      if (allocationError) throw allocationError;
    }

    await sendParticipantDecisionSummaryNotification({
      participantId: application.participant_id,
      projectId: application.project_id,
      projectTitle: projectRow?.title || 'Project',
      preferredType: 'PRODUCT_APPLICATION_APPROVED',
      decisionAnchorAt: application.reviewed_at
    });

    res.json({
      success: true,
      message: 'Product application approved and allocation created',
      data: {
        approved_budget: normalizedAllocatedBudget,
        remaining_project_budget: Math.max(0, remainingBudgetBeforeApproval - normalizedAllocatedBudget)
      }
    });

    const productLabel = productRow?.name || 'selected product';
    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PRODUCT_APPLICATION_APPROVED',
      entityType: 'PROJECT_APPLICATION',
      entityId: id,
      message: `Product application ${id} approved for ${productLabel} (Rs ${normalizedAllocatedBudget})`
    });
  } catch (err) {
    next(err);
  }
};

const rejectProductApplication = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { eligibility_notes } = req.body;

    const { data, error } = await supabase
      .from('project_applications')
      .update({
        status: 'REJECTED',
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
        eligibility_notes: eligibility_notes || null
      })
      .eq('id', id)
      .eq('status', 'PENDING')
      .select('id, participant_id, project_id, product_id, reviewed_at')
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Application not found or already processed'
      });
    }

    const { data: projectRow } = data?.project_id
      ? await supabase
          .from('projects')
          .select('id, title')
          .eq('id', data.project_id)
          .maybeSingle()
      : { data: null };

    await sendParticipantDecisionSummaryNotification({
      participantId: data.participant_id,
      projectId: data.project_id,
      projectTitle: projectRow?.title || 'Project',
      preferredType: 'PRODUCT_APPLICATION_REJECTED',
      decisionAnchorAt: data.reviewed_at
    });

    res.json({
      success: true,
      message: 'Product application rejected'
    });

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PRODUCT_APPLICATION_REJECTED',
      entityType: 'PROJECT_APPLICATION',
      entityId: id,
      message: `Product application ${id} rejected`
    });
  } catch (err) {
    next(err);
  }
};

const bulkDecideApplications = async (req, res, next) => {
  try {
    const rawDecisions = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
    if (!rawDecisions.length) {
      return res.status(400).json({
        success: false,
        message: 'decisions array is required'
      });
    }

    const normalizedDecisions = rawDecisions
      .map((decision) => ({
        applicationId: String(decision?.applicationId || '').trim(),
        action: String(decision?.action || '').trim().toUpperCase()
      }))
      .filter((decision) => decision.applicationId);

    if (!normalizedDecisions.length) {
      return res.status(400).json({
        success: false,
        message: 'No valid decisions were provided'
      });
    }

    const validActions = new Set(['APPROVE', 'REJECT']);
    const malformed = normalizedDecisions.filter((d) => !validActions.has(d.action));
    if (malformed.length) {
      return res.status(400).json({
        success: false,
        message: 'Each decision must include action: APPROVE or REJECT'
      });
    }

    const dedupedMap = new Map();
    normalizedDecisions.forEach((decision) => dedupedMap.set(decision.applicationId, decision));
    const decisions = Array.from(dedupedMap.values());
    const applicationIds = decisions.map((d) => d.applicationId);

    const { data: applications, error: applicationsError } = await supabase
      .from('project_applications')
      .select('id, participant_id, project_id, product_id, status')
      .in('id', applicationIds);
    if (applicationsError) throw applicationsError;

    const appMap = new Map((applications || []).map((row) => [row.id, row]));
    const productIds = [
      ...new Set(
        (applications || [])
          .map((row) => row.product_id)
          .filter(Boolean)
      )
    ];

    const productMap = new Map();
    if (productIds.length) {
      const { data: productRows, error: productError } = await supabase
        .from('project_products')
        .select('id, product_value')
        .in('id', productIds);
      if (productError && !isMissingSchemaObjectError(productError)) throw productError;
      (productRows || []).forEach((row) => productMap.set(row.id, row));
    }

    const successes = [];
    const failures = [];

    await Promise.all(decisions.map(async (decision) => {
      const app = appMap.get(decision.applicationId);
      if (!app) {
        failures.push({
          applicationId: decision.applicationId,
          action: decision.action,
          reason: 'Application not found'
        });
        return;
      }

      if (String(app.status || '').toUpperCase() !== 'PENDING') {
        failures.push({
          applicationId: decision.applicationId,
          action: decision.action,
          reason: `Application already processed (${app.status})`
        });
        return;
      }

      const reviewedAt = new Date().toISOString();
      if (decision.action === 'APPROVE') {
        const productValue = toAmount(productMap.get(app.product_id)?.product_value);
        const { data: updated, error: updateError } = await supabase
          .from('project_applications')
          .update({
            status: 'APPROVED',
            allocated_budget: productValue,
            reviewed_by: req.user?.id || null,
            reviewed_at: reviewedAt
          })
          .eq('id', app.id)
          .eq('status', 'PENDING')
          .select('id, participant_id, project_id, product_id, status')
          .maybeSingle();

        if (updateError || !updated) {
          failures.push({
            applicationId: decision.applicationId,
            action: decision.action,
            reason: updateError?.message || 'Failed to approve application'
          });
          return;
        }

        successes.push({
          applicationId: updated.id,
          participantId: updated.participant_id,
          projectId: updated.project_id,
          productId: updated.product_id,
          action: decision.action
        });
        return;
      }

      const { data: updated, error: updateError } = await supabase
        .from('project_applications')
        .update({
          status: 'REJECTED',
          reviewed_by: req.user?.id || null,
          reviewed_at: reviewedAt
        })
        .eq('id', app.id)
        .eq('status', 'PENDING')
        .select('id, participant_id, project_id, product_id, status')
        .maybeSingle();

      if (updateError || !updated) {
        failures.push({
          applicationId: decision.applicationId,
          action: decision.action,
          reason: updateError?.message || 'Failed to reject application'
        });
        return;
      }

      successes.push({
        applicationId: updated.id,
        participantId: updated.participant_id,
        projectId: updated.project_id,
        productId: updated.product_id,
        action: decision.action
      });
    }));

    const successfulIds = successes.map((row) => row.applicationId);
    const successMetaMap = new Map();

    if (successfulIds.length) {
      const { data: successRows, error: successRowsError } = await supabase
        .from('project_applications')
        .select(`
          id,
          participant_id,
          project_id,
          product_id,
          status,
          project_products:project_products(id, name, product_url, product_value, image_url),
          projects:projects(id, title)
        `)
        .in('id', successfulIds);
      if (successRowsError) throw successRowsError;
      (successRows || []).forEach((row) => successMetaMap.set(row.id, row));
    }

    const participantDecisionMap = new Map();
    for (const item of successes) {
      const participantId = item.participantId;
      if (!participantDecisionMap.has(participantId)) {
        participantDecisionMap.set(participantId, { approved: [], rejected: [] });
      }
      const bucket = participantDecisionMap.get(participantId);
      const meta = successMetaMap.get(item.applicationId) || null;
      if (item.action === 'APPROVE') bucket.approved.push(meta);
      if (item.action === 'REJECT') bucket.rejected.push(meta);
    }

    const participantIds = [...participantDecisionMap.keys()];
    const participantProfileMap = new Map();
    if (participantIds.length) {
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', participantIds);
      if (profilesError) throw profilesError;
      (profiles || []).forEach((row) => participantProfileMap.set(row.id, row));
    }

    const participantErrors = [];
    const participantAllocationMap = new Map();
    for (const participantId of participantIds) {
      const decisionsForParticipant = participantDecisionMap.get(participantId);
      const approved = decisionsForParticipant?.approved || [];
      const rejected = decisionsForParticipant?.rejected || [];

      try {
        let allocationId = null;
        if (approved.length > 0) {
          let allocationLookup = await supabase
            .from('unit_allocations')
            .select('id')
            .eq('participant_id', participantId)
            .in('status', [ALLOCATION_STATUS.RESERVED, ALLOCATION_STATUS.PURCHASED])
            .is('completed_at', null)
            .limit(1)
            .maybeSingle();

          if (allocationLookup.error && /completed_at/i.test(String(allocationLookup.error.message || ''))) {
            allocationLookup = await supabase
              .from('unit_allocations')
              .select('id')
              .eq('participant_id', participantId)
              .in('status', [ALLOCATION_STATUS.RESERVED, ALLOCATION_STATUS.PURCHASED])
              .limit(1)
              .maybeSingle();
          }

          if (allocationLookup.error && /status/i.test(String(allocationLookup.error.message || ''))) {
            allocationLookup = await supabase
              .from('unit_allocations')
              .select('id')
              .eq('participant_id', participantId)
              .limit(1)
              .maybeSingle();
          }

          if (allocationLookup.error && !isMissingSchemaObjectError(allocationLookup.error)) {
            throw allocationLookup.error;
          }

          allocationId = allocationLookup?.data?.id || null;
          if (!allocationId) {
            const firstApproved = approved.find(Boolean);
            const reservedUntil = new Date();
            reservedUntil.setDate(reservedUntil.getDate() + 20);
            const { data: createdAllocation, error: createAllocationError } = await supabase
              .from('unit_allocations')
              .insert({
                participant_id: participantId,
                project_id: firstApproved?.project_id || null,
                status: ALLOCATION_STATUS.RESERVED,
                reserved_until: reservedUntil.toISOString()
              })
              .select('id')
              .maybeSingle();
            if (createAllocationError) throw createAllocationError;
            allocationId = createdAllocation?.id || null;
          }
        }

        participantAllocationMap.set(participantId, allocationId);

        const approvedCount = approved.length;
        await supabase
          .from('notifications')
          .insert({
            user_id: participantId,
            type: 'PRODUCT_APPLICATION_APPROVED',
            title: approvedCount > 0 ? `${approvedCount} product(s) approved!` : 'Product request update',
            message: approvedCount > 0
              ? `${approvedCount} product(s) approved. Go to My Tasks to upload your invoice and review.`
              : `Your product requests have been reviewed. Check your dashboard for details.`
          });

        const participant = participantProfileMap.get(participantId);
        if (!participant?.email) continue;

        const approvedProducts = approved
          .filter(Boolean)
          .map((app) => ({
            name: app?.project_products?.name || 'Product',
            image_url: app?.project_products?.image_url || null,
            product_url: app?.project_products?.product_url || null,
            product_value: app?.project_products?.product_value || null,
            brand: app?.projects?.title || null
          }));

        const rejectedProducts = rejected
          .filter(Boolean)
          .map((app) => ({
            name: app?.project_products?.name || 'Product',
            image_url: app?.project_products?.image_url || null,
            brand: app?.projects?.title || null
          }));

        const uniqueBrands = new Set(
          [...approvedProducts, ...rejectedProducts]
            .map((row) => String(row.brand || '').trim())
            .filter(Boolean)
        );
        const emailProjectTitle = approvedProducts.length > 0 && rejectedProducts.length > 0
          ? 'Your Product Requests'
          : uniqueBrands.size > 1
            ? 'Your Product Requests'
            : (approvedProducts[0]?.brand || rejectedProducts[0]?.brand || 'Nitro');

        const dashboardUrl = `${env.frontendUrl.replace(/\/$/, '')}/participant/${participantId}/allocation/active`;
        const invoiceUrl   = dashboardUrl;
        const reviewUrl    = dashboardUrl;
        setImmediate(() => {
          sendEmail({
            to: participant.email,
            subject: approvedProducts.length > 0
              ? '🎉 Products Approved — Upload Your Invoice Now'
              : 'Update on Your Product Requests',
            html: productDecisionEmail(
              participant.full_name,
              emailProjectTitle,
              approvedProducts,
              rejectedProducts,
              dashboardUrl,
              invoiceUrl,
              reviewUrl
            )
          }).catch(() => {});
        });
      } catch (participantError) {
        participantErrors.push({
          participantId,
          reason: participantError?.message || 'Failed while processing participant summary'
        });
      }
    }

    res.json({
      success: true,
      message: 'Bulk decisions processed',
      data: {
        requested: decisions.length,
        succeeded: successes.length,
        failed: failures.length,
        failures,
        participant_errors: participantErrors,
        allocations: Array.from(participantAllocationMap.entries()).map(([participantId, allocationId]) => ({
          participantId,
          allocationId
        }))
      }
    });

    if (successes.length) {
      await logActivity({
        actorId: req.user?.id,
        actorRole: req.user?.role,
        action: 'PRODUCT_APPLICATIONS_BULK_DECIDED',
        entityType: 'PROJECT_APPLICATION',
        entityId: `bulk:${successes.length}`,
        message: `Bulk-decided ${successes.length} application(s); ${failures.length} failed`
      });
    }
  } catch (err) {
    next(err);
  }
};

/**
 * Approve purchase proof.
 * D2C: purchase proof approval can mark payout eligible.
 * Marketplace: payout stays pending until review/feedback workflow completes.
 */
const approvePurchaseProof = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: proof, error } = await supabase
      .from('purchase_proofs')
      .update({ status: 'APPROVED' })
      .eq('id', id)
      .eq('status', 'PENDING')
      .select('id, allocation_id, participant_id')
      .maybeSingle();
    if (error) throw error;

    let proofRow = proof;
    let alreadyProcessed = false;

    if (!proofRow) {
      const { data: existingById, error: existingByIdError } = await supabase
        .from('purchase_proofs')
        .select('id, allocation_id, participant_id, status')
        .eq('id', id)
        .maybeSingle();
      if (existingByIdError) throw existingByIdError;

      if (existingById) {
        proofRow = existingById;
        alreadyProcessed = String(existingById.status || '').toUpperCase() === 'APPROVED';
      } else {
        const { data: existingByAllocation, error: existingByAllocationError } = await supabase
          .from('purchase_proofs')
          .select('id, allocation_id, participant_id, status')
          .eq('allocation_id', id)
          .order('uploaded_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existingByAllocationError) throw existingByAllocationError;

        if (!existingByAllocation) {
          return res.status(404).json({
            success: false,
            message: 'Purchase proof not found'
          });
        }

        proofRow = existingByAllocation;
        if (String(existingByAllocation.status || '').toUpperCase() === 'PENDING') {
          const { data: promoted, error: promotedError } = await supabase
            .from('purchase_proofs')
            .update({ status: 'APPROVED' })
            .eq('id', existingByAllocation.id)
            .eq('status', 'PENDING')
            .select('id, allocation_id, participant_id')
            .maybeSingle();
          if (promotedError) throw promotedError;
          if (promoted) {
            proofRow = promoted;
          } else {
            alreadyProcessed = true;
          }
        } else {
          alreadyProcessed = true;
        }
      }
    }

    const { data: allocation, error: allocationError } = await supabase
      .from('unit_allocations')
      .select('project_id, participant_id, projects ( mode, reward )')
      .eq('id', proofRow.allocation_id)
      .maybeSingle();

    if (allocationError) throw allocationError;

    let payoutCreated = false;
    if (allocation) {
      const projectMode = String(allocation?.projects?.mode || '').toUpperCase();
      // FIX: For both D2C and MARKETPLACE, create payout on proof approval
      // (MARKETPLACE proof approval signals purchase happened — review approval creates final payout via ensureEligiblePayout)
      if (projectMode === 'D2C' || projectMode === 'MARKETPLACE') {
        const { data: existingPayout, error: payoutLookupError } = await supabase
          .from('payouts')
          .select('id')
          .eq('participant_id', allocation.participant_id)
          .eq('project_id', allocation.project_id)
          .maybeSingle();

        if (payoutLookupError) throw payoutLookupError;

        if (!existingPayout) {
          const breakdown = await calculatePayoutBreakdown({
            supabase,
            participantId: allocation.participant_id,
            projectId: allocation.project_id,
            fallbackReward: allocation?.projects?.reward
          });

          let payoutError = null;
          ({ error: payoutError } = await supabase
            .from('payouts')
            .insert({
              participant_id: allocation.participant_id,
              user_id: allocation.participant_id,
              project_id: allocation.project_id,
              purchase_proof_id: proofRow.id,
              amount: Number(breakdown.totalAmount || 0),
              status: 'ELIGIBLE'
            }));

          if (payoutError && isMissingSchemaObjectError(payoutError)) {
            ({ error: payoutError } = await supabase
              .from('payouts')
              .insert({
                participant_id: allocation.participant_id,
                user_id: allocation.participant_id,
                project_id: allocation.project_id,
                amount: Number(breakdown.totalAmount || 0),
                status: 'ELIGIBLE'
              }));
          }

          if (payoutError && isMissingSchemaObjectError(payoutError)) {
            ({ error: payoutError } = await supabase
              .from('payouts')
              .insert({
                participant_id: allocation.participant_id,
                project_id: allocation.project_id,
                purchase_proof_id: proofRow.id,
                amount: Number(breakdown.totalAmount || 0),
                status: 'ELIGIBLE'
              }));
          }

          if (payoutError && isMissingSchemaObjectError(payoutError)) {
            ({ error: payoutError } = await supabase
              .from('payouts')
              .insert({
                participant_id: allocation.participant_id,
                project_id: allocation.project_id,
                amount: Number(breakdown.totalAmount || 0),
                status: 'ELIGIBLE'
              }));
          }

          if (payoutError) throw payoutError;
          payoutCreated = true;
        }

        const completionRes = await supabase
          .from('unit_allocations')
          .update({ completed_at: new Date().toISOString() })
          .eq('id', proofRow.allocation_id)
          .eq('participant_id', allocation.participant_id)
          .is('completed_at', null);

        if (completionRes.error && isMissingSchemaObjectError(completionRes.error)) {
          const statusOnlyRes = await supabase
            .from('unit_allocations')
            .update({ status: ALLOCATION_STATUS.COMPLETED })
            .eq('id', proof.allocation_id)
            .eq('participant_id', allocation.participant_id);

          if (statusOnlyRes.error && !isMissingSchemaObjectError(statusOnlyRes.error)) {
            throw statusOnlyRes.error;
          }
        } else if (completionRes.error) {
          throw completionRes.error;
        }
      }
    }

    const { data: participant } = await supabase
      .from('profiles')
      .select('email, full_name')
      .eq('id', proofRow.participant_id)
      .maybeSingle();

    const { purchaseApprovedEmail } = require('../services/email.templates');
    const { data: proofProject } = allocation?.project_id
      ? await supabase.from('projects').select('title, name').eq('id', allocation.project_id).maybeSingle()
      : { data: null };
    const proofProjectName = proofProject?.title || proofProject?.name || null;

    if (participant?.email) {
      sendEmail({
        to: participant.email,
        subject: '✅ Invoice Approved — Submit Your Review',
        html: purchaseApprovedEmail(participant.full_name, proofProjectName, [])
      });
    }

    res.json({
      success: true,
      message: payoutCreated
        ? 'Purchase proof approved and payout eligibility created'
        : alreadyProcessed
          ? 'Purchase proof already approved'
          : 'Purchase proof approved'
    });

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PURCHASE_PROOF_APPROVED',
      entityType: 'PURCHASE_PROOF',
      entityId: id,
      message: `Purchase proof ${id} approved`
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Generate payout batch
 */
const generatePayoutBatch = async (req, res, next) => {
  try {
    await backfillEligiblePayouts();

    const { data: payouts, error } = await supabase
      .from('payouts')
      .select('id, amount')
      .eq('status', 'ELIGIBLE');

    if (error) throw error;

    if (!payouts || payouts.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No eligible payouts found'
      });
    }

    const totalAmount = payouts.reduce(
      (sum, p) => sum + Number(p.amount),
      0
    );

    const { data: batch, error: batchError } = await supabase
      .from('payout_batches')
      .insert({
        total_amount: totalAmount,
        created_by: req.user.id
      })
      .select()
      .single();

    if (batchError) throw batchError;

    const payoutIds = payouts.map(p => p.id);

    const { error: updateError } = await supabase
      .from('payouts')
      .update({
        payout_batch_id: batch.id,
        status: 'IN_BATCH'
      })
      .in('id', payoutIds);

    if (updateError) throw updateError;

    res.json({
      success: true,
      message: 'Payout batch created successfully',
      data: {
        batch_id: batch.id,
        total_amount: totalAmount,
        payout_count: payoutIds.length
      }
    });

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PAYOUT_BATCH_CREATED',
      entityType: 'PAYOUT_BATCH',
      entityId: batch.id,
      message: `Payout batch ${batch.id} created with ${payoutIds.length} payouts`
    });

    const { data: participants } = await supabase
      .from('payouts')
      .select('profiles ( email )')
      .eq('payout_batch_id', batch.id);

    (participants || []).forEach((row) => {
      const email = row?.profiles?.email;
      if (email) {
        sendEmail({
          to: email,
          subject: 'Payout batch created',
          html: `<p>Your payout has been added to batch <b>${batch.id}</b>.</p>`
        });
      }
    });
  } catch (err) {
    next(err);
  }
};

const getEligiblePayouts = async (req, res, next) => {
  try {
    await backfillEligiblePayouts();

    // Optional filters from query params
    const filterProjectId = req.query.project_id ? String(req.query.project_id) : null;
    const filterClientId = req.query.client_id ? String(req.query.client_id) : null;

    let payoutsQuery = supabase
      .from('payouts')
      .select('id, participant_id, project_id, product_id, amount, status, created_at, payout_batch_id');

    if (filterProjectId) {
      payoutsQuery = payoutsQuery.eq('project_id', filterProjectId);
    }
    
    // Always filter for ELIGIBLE in the query for performance
    payoutsQuery = payoutsQuery.eq('status', 'ELIGIBLE');

    let payoutsRes = await payoutsQuery.order('created_at', { ascending: true });

    let hasProductColumn = true;
    if (payoutsRes.error && /product_id/i.test(String(payoutsRes.error.message || ''))) {
      hasProductColumn = false;
      payoutsRes = await supabase
        .from('payouts')
        .select('id, participant_id, project_id, amount, status, created_at, payout_batch_id')
        .eq('status', 'ELIGIBLE')
        .order('created_at', { ascending: true });
    }

    if (payoutsRes.error && /created_at/i.test(String(payoutsRes.error.message || ''))) {
      payoutsRes = await supabase
        .from('payouts')
        .select(hasProductColumn ? 'id, participant_id, project_id, product_id, amount, status, payout_batch_id' : 'id, participant_id, project_id, amount, status, payout_batch_id')
        .eq('status', 'ELIGIBLE');
    }
    if (payoutsRes.error) throw payoutsRes.error;
    console.log('payoutsRes.data', payoutsRes.data);

    const data = (payoutsRes.data || []).filter(
      (row) => normalizeStatus(row?.status) === 'ELIGIBLE'
    );
    const participantIds = [...new Set(data.map((row) => row.participant_id).filter(Boolean))];
    const projectIds = [...new Set(data.map((row) => row.project_id).filter(Boolean))];
    const productIds = hasProductColumn
      ? [...new Set(data.map((row) => row.product_id).filter(Boolean))]
      : [];

    const [profilesRes, projectsRes, productsRes, breakdownMap, applicationsRes] = await Promise.all([
      participantIds.length
        ? supabase
            .from('profiles')
            .select('id, full_name, email')
            .in('id', participantIds)
        : Promise.resolve({ data: [], error: null }),
      projectIds.length
        ? supabase
            .from('projects')
            .select('id, title, name, reward, total_units, created_by')
            .in('id', projectIds)
        : Promise.resolve({ data: [], error: null }),
      productIds.length
        ? supabase
            .from('project_products')
            .select('id, name, product_value')
            .in('id', productIds)
        : Promise.resolve({ data: [], error: null }),
      getApprovedApplicationBreakdownMap({ participantIds, projectIds }),
      participantIds.length && projectIds.length
        ? supabase
            .from('project_applications')
            .select(
              `
              id,
              participant_id,
              project_id,
              product_id,
              allocated_budget,
              status,
              created_at,
              project_products (
                id,
                name,
                product_value
              )
            `
            )
            .in('participant_id', participantIds)
            .in('project_id', projectIds)
            .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED'])
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [], error: null })
    ]);

    if (profilesRes.error) throw profilesRes.error;
    if (projectsRes.error) throw projectsRes.error;
    if (productsRes.error && !isMissingSchemaObjectError(productsRes.error)) throw productsRes.error;
    if (applicationsRes.error && !isMissingSchemaObjectError(applicationsRes.error)) throw applicationsRes.error;

    // Fetch client (brand) profiles — the users who created each project
    const clientIds = [...new Set((projectsRes.data || []).map((p) => p.created_by).filter(Boolean))];
    let clientProfileMap = new Map();
    if (clientIds.length) {
      const { data: clientProfiles } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', clientIds);
      clientProfileMap = new Map((clientProfiles || []).map((p) => [p.id, p]));
    }

    // Fetch project budgets: total allocated_budget per project from approved/purchased/completed apps
    let projectBudgetMap = new Map(); // projectId -> { total_budget, spent_budget }
    if (projectIds.length) {
      // Get project budget from the projects table if it exists, or compute from applications
      const { data: budgetApps } = await supabase
        .from('project_applications')
        .select('project_id, allocated_budget')
        .in('project_id', projectIds)
        .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED'])
        .not('allocated_budget', 'is', null);

      const spentByProject = new Map();
      for (const app of (budgetApps || [])) {
        const prev = toAmount(spentByProject.get(app.project_id));
        spentByProject.set(app.project_id, prev + toAmount(app.allocated_budget));
      }

      // Also try to get the project's own budget field if it exists
      const { data: projectBudgets } = await supabase
        .from('projects')
        .select('id, budget')
        .in('id', projectIds);

      for (const proj of (projectBudgets || [])) {
        const spent = toAmount(spentByProject.get(proj.id));
        const total = toAmount(proj.budget);
        projectBudgetMap.set(proj.id, {
          total_budget: total,
          spent_budget: spent,
          remaining_budget: total > 0 ? Math.max(0, total - spent) : null
        });
      }

      // For projects without a budget field, still store spent
      for (const [pid, spent] of spentByProject.entries()) {
        if (!projectBudgetMap.has(pid)) {
          projectBudgetMap.set(pid, { total_budget: null, spent_budget: spent, remaining_budget: null });
        }
      }
    }

    const profileMap = new Map((profilesRes.data || []).map((row) => [row.id, row]));
    const projectMap = new Map((projectsRes.data || []).map((row) => [row.id, row]));
    const productMap = new Map((productsRes.data || []).map((row) => [row.id, row]));
    const appMap = new Map();
    for (const row of (applicationsRes.data || [])) {
      const key = `${row.participant_id}::${row.project_id}`;
      if (!appMap.has(key)) appMap.set(key, row);
    }

    const rows = (data || []).map((row) => {
      const key = `${row.participant_id}::${row.project_id}`;
      const breakdown = breakdownMap.get(key) || {};
      const project = projectMap.get(row.project_id) || {};
      const app = appMap.get(key) || null;
      const product = hasProductColumn ? (productMap.get(row.product_id) || null) : null;
      const rewardAmount = toAmount(breakdown.rewardAmount ?? project.reward);
      // Use product_value as primary source of truth. allocated_budget is only
      // a fallback when product_value is missing/zero to avoid accidental overrides.
      const mappedProductAmount = product ? toAmount(product.product_value) : 0;
      const appCatalogueAmount = toAmount(app?.project_products?.product_value);
      const appAllocatedBudget = toAmount(app?.allocated_budget);
      const productAmount = mappedProductAmount > 0
        ? mappedProductAmount
        : appCatalogueAmount > 0
          ? appCatalogueAmount
          : appAllocatedBudget > 0
            ? appAllocatedBudget
            : toAmount(breakdown.productAmount);      const computedTotal = rewardAmount + productAmount;
      const clientProfile = project.created_by ? (clientProfileMap.get(project.created_by) || null) : null;
      const budgetInfo = projectBudgetMap.get(row.project_id) || null;
      return {
        ...row,
        profiles: profileMap.get(row.participant_id) || null,
        projects: project || null,
        product_name: product?.name || app?.project_products?.name || null,
        reward_amount: rewardAmount,
        product_amount: productAmount,
        allocated_budget: toAmount(app?.allocated_budget),
        total_amount: computedTotal > 0
          ? Number(computedTotal)
          : Number(row.amount || breakdown.totalAmount || 0),
        client: clientProfile
          ? {
              id: project.created_by,
              full_name: clientProfile.full_name || clientProfile.email || null,
              email: clientProfile.email || null
            }
          : null,
        project_budget: budgetInfo
      };
    });

    // Apply client filter if provided (post-filter since we need project data)
    const filteredRows = filterClientId
      ? rows.filter((row) => row.client?.id === filterClientId)
      : rows;

    // Build filter options for the frontend
    const uniqueProjects = [...projectMap.values()].map((p) => ({
      id: p.id,
      title: p.title || p.name || p.id,
      client_id: p.created_by || null,
      client_name: p.created_by ? (clientProfileMap.get(p.created_by)?.full_name || clientProfileMap.get(p.created_by)?.email || null) : null
    }));
    const uniqueClients = [...clientProfileMap.entries()].map(([id, profile]) => ({
      id,
      full_name: profile.full_name || profile.email || id,
      email: profile.email || null
    }));

    res.json({
      success: true,
      data: filteredRows,
      meta: {
        total: filteredRows.length,
        filter_options: {
          projects: uniqueProjects,
          clients: uniqueClients
        }
      }
    });
  } catch (err) {
    next(err);
  }
};

const getPayoutBatches = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const requestedStatus = normalizeStatus(req.query.status || 'ALL');
    const from = (Number(page) - 1) * Number(limit);
    const to = from + Number(limit) - 1;

    let query = supabase
      .from('payout_batches')
      .select('id, total_amount, status, created_at, created_by', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (requestedStatus === 'ACTIVE') {
      query = query.neq('status', 'PAID');
    } else if (requestedStatus === 'IN_BATCH') {
      query = query.in('status', ['IN_BATCH', 'PENDING']);
    } else if (requestedStatus !== 'ALL') {
      query = query.eq('status', requestedStatus);
    }

    const { data, count, error } = await query.range(from, to);

    if (error) throw error;

    const batchRows = data || [];
    const batchIds = batchRows.map((row) => row.id).filter(Boolean);

    let payoutsRes = { data: [], error: null };
    if (batchIds.length) {
      payoutsRes = await supabase
        .from('payouts')
        .select('id, payout_batch_id, participant_id, project_id, product_id, amount, status')
        .in('payout_batch_id', batchIds);

      if (payoutsRes.error && /product_id|project_id/i.test(String(payoutsRes.error.message || ''))) {
        payoutsRes = await supabase
          .from('payouts')
          .select('id, payout_batch_id, participant_id, amount, status')
          .in('payout_batch_id', batchIds);
      }
      if (payoutsRes.error) throw payoutsRes.error;
    }

    const payoutRows = payoutsRes.data || [];
    const participantIds = [...new Set(payoutRows.map((row) => row.participant_id).filter(Boolean))];
    const projectIds    = [...new Set(payoutRows.map((row) => row.project_id).filter(Boolean))];
    const productIds    = [...new Set(payoutRows.map((row) => row.product_id).filter(Boolean))];

    let profilesRes = { data: [], error: null };
    let detailsRes  = { data: [], error: null };
    let productsRes = { data: [], error: null };
    let projectsRes = { data: [], error: null };
    let applicationsRes = { data: [], error: null };

    // Fetch projects to get reward amounts for matching
    if (projectIds.length) {
      projectsRes = await supabase
        .from('projects')
        .select('id, title, reward')
        .in('id', projectIds);
      if (projectsRes.error) throw projectsRes.error;
    }

    // Fetch products for direct product_ids on payouts
    if (productIds.length) {
      productsRes = await supabase
        .from('project_products')
        .select('id, name, product_value')
        .in('id', productIds);
      if (productsRes.error && !isMissingSchemaObjectError(productsRes.error)) throw productsRes.error;
    }

    // Fetch applications WITH nested product join — same approach as getEligiblePayouts
    if (participantIds.length) {
      let appQuery = supabase
        .from('project_applications')
        .select(`
          id,
          participant_id,
          project_id,
          product_id,
          allocated_budget,
          status,
          project_products (
            id,
            name,
            product_value
          )
        `)
        .in('participant_id', participantIds)
        .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED', 'IN_BATCH', 'PAID'])
        .order('created_at', { ascending: true });

      if (projectIds.length) {
        appQuery = appQuery.in('project_id', projectIds);
      }

      let appRes = await appQuery;

      // Fallback: if nested join fails, fetch flat + fetch products separately
      if (appRes.error) {
        appRes = await supabase
          .from('project_applications')
          .select('id, participant_id, project_id, product_id, allocated_budget, status')
          .in('participant_id', participantIds)
          .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED', 'IN_BATCH', 'PAID'])
          .order('created_at', { ascending: true });
      }
      if (appRes.error && !isMissingSchemaObjectError(appRes.error)) throw appRes.error;
      applicationsRes = appRes;

      // Collect any product_ids from applications not yet in productsRes
      const appProductIds = [...new Set((applicationsRes.data || []).map((r) => r.product_id).filter(Boolean))];
      const knownProductIds = new Set((productsRes.data || []).map((r) => r.id));
      const missingProductIds = appProductIds.filter((id) => !knownProductIds.has(id));
      if (missingProductIds.length) {
        const extraRes = await supabase
          .from('project_products')
          .select('id, name, product_value')
          .in('id', missingProductIds);
        if (!extraRes.error) {
          productsRes = { data: [...(productsRes.data || []), ...(extraRes.data || [])], error: null };
        }
      }
    }
    if (participantIds.length) {
      profilesRes = await supabase
        .from('profiles')
        .select(
          `
          id,
          full_name,
          email
          `
        )
        .in('id', participantIds);

      if (profilesRes.error && isMissingSchemaObjectError(profilesRes.error)) {
        profilesRes = await supabase
          .from('profiles')
          .select('id, full_name, email')
          .in('id', participantIds);
      }
      if (profilesRes.error) throw profilesRes.error;

      detailsRes = await supabase
        .from('participant_details')
        .select(
          `
          participant_id,
          bank_account_name,
          bank_account_number,
          bank_ifsc,
          bank_name,
          address_line1,
          address_line2,
          city,
          state,
          pincode,
          country
          `
        )
        .in('participant_id', participantIds);
      if (detailsRes.error && !isMissingSchemaObjectError(detailsRes.error)) throw detailsRes.error;
    }

    const projectMapLookup = new Map((projectsRes.data || []).map((row) => [row.id, row]));
    const profileMap = new Map((profilesRes.data || []).map((row) => [row.id, row]));
    const detailMap = new Map((detailsRes.data || []).map((row) => [row.participant_id, row]));
    const productMap = new Map((productsRes.data || []).map((row) => [row.id, row]));

    // Map: participantId → sorted list of apps
    const appsByParticipant = new Map();
    for (const app of (applicationsRes.data || [])) {
      const pid = app.participant_id;
      if (!pid) continue;
      if (!appsByParticipant.has(pid)) appsByParticipant.set(pid, []);
      appsByParticipant.get(pid).push(app);
    }

    // Track consumed apps by reference
    const usedApps = new Set();
    const participantsByBatchId = new Map();

    for (const payout of payoutRows) {
      const batchId = payout?.payout_batch_id;
      const participantId = payout?.participant_id;
      if (!batchId || !participantId) continue;

      if (!participantsByBatchId.has(batchId)) {
        participantsByBatchId.set(batchId, []);
      }

      const profile = profileMap.get(participantId) || {};
      const details = detailMap.get(participantId) || {};
      const project = projectMapLookup.get(payout.project_id) || {};
      const rewardAmount = toAmount(project.reward);
      const participantApps = appsByParticipant.get(participantId) || [];

      let productName = null;
      let productAmount = null;
      let resolvedApp = null;

      // Derived product amount (Total - Reward)
      const expectedProductAmount = Math.max(0, toAmount(payout.amount) - rewardAmount);

      // Strategy 1: payout has product_id → direct exact match
      if (payout.product_id) {
        const prod = productMap.get(payout.product_id);
        if (prod) {
          productName = prod.name || null;
          productAmount = toAmount(prod.product_value);
        }
        const exactApp = participantApps.find(
          (a) => !usedApps.has(a) && a.product_id === payout.product_id
        );
        if (exactApp) {
          if (exactApp.allocated_budget != null) productAmount = toAmount(exactApp.allocated_budget);
          resolvedApp = exactApp;
        }
      }

      // Strategy 2: payout has project_id → match unused app for same project+product_amount
      if (!productName && payout.project_id) {
        // Try to match by project_id AND product_amount first
        let matchedApp = participantApps.find(
          (a) => !usedApps.has(a) &&
                 a.project_id === payout.project_id &&
                 toAmount(a.allocated_budget) === expectedProductAmount
        );
        // Fallback: just match by project_id
        if (!matchedApp) {
          matchedApp = participantApps.find(
            (a) => !usedApps.has(a) && a.project_id === payout.project_id
          );
        }
        if (matchedApp) {
          const prod = matchedApp.product_id ? productMap.get(matchedApp.product_id) : null;
          productName = prod?.name || null;
          productAmount = toAmount(matchedApp.allocated_budget ?? prod?.product_value);
          resolvedApp = matchedApp;
        }
      }

      // Strategy 3: match by product_amount — find unused app whose allocated_budget equals expectedProductAmount
      if (!productName && expectedProductAmount > 0) {
        const amountMatch = participantApps.find(
          (a) => !usedApps.has(a) && toAmount(a.allocated_budget) === expectedProductAmount
        );
        if (amountMatch) {
          const prod = amountMatch.product_id ? productMap.get(amountMatch.product_id) : null;
          productName = prod?.name || null;
          productAmount = toAmount(amountMatch.allocated_budget ?? prod?.product_value);
          resolvedApp = amountMatch;
        }
      }

      // Strategy 4: fallback to next unused app for this participant
      if (!productName) {
        const unusedApp = participantApps.find((a) => !usedApps.has(a));
        if (unusedApp) {
          const prod = unusedApp.product_id ? productMap.get(unusedApp.product_id) : null;
          productName = prod?.name || null;
          productAmount = toAmount(unusedApp.allocated_budget ?? prod?.product_value);
          resolvedApp = unusedApp;
        }
      }

      // Final fallback if still no product name but we have a product amount
      if (!productName && expectedProductAmount > 0) {
        productAmount = expectedProductAmount;
        productName = "Product";
      }

      // Mark this app as consumed
      if (resolvedApp) usedApps.add(resolvedApp);

      participantsByBatchId.get(batchId).push({
        id: participantId,
        payout_id: payout.id,
        payout_status: normalizeStatus(payout.status),
        full_name: profile.full_name || null,
        email: profile.email || null,
        product_name: productName,
        product_amount: productAmount || expectedProductAmount,
        reward_amount: rewardAmount,
        total_amount: toAmount(payout.amount),
        bank_account_name: details.bank_account_name || null,
        bank_account_number: details.bank_account_number || null,
        bank_ifsc: details.bank_ifsc || null,
        bank_name: details.bank_name || null,
        address_line1: details.address_line1 || null,
        address_line2: details.address_line2 || null,
        city: details.city || null,
        state: details.state || null,
        pincode: details.pincode || null,
        country: details.country || null
      });
    }

    const enrichedRows = batchRows.map((batch) => {
      const participants = participantsByBatchId.get(batch.id) || [];
      return {
        ...batch,
        participant_count: participants.length,
        participants
      };
    });

    res.json({
      success: true,
      data: enrichedRows,
      meta: {
        page: Number(page),
        limit: Number(limit),
        total: count || 0
      }
    });
  } catch (err) {
    next(err);
  }
};

const markPayoutBatchPaid = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: batch, error: batchLookupError } = await supabase
      .from('payout_batches')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();

    if (batchLookupError) throw batchLookupError;
    if (!batch) {
      return res.status(404).json({
        success: false,
        message: 'Payout batch not found'
      });
    }

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

    const { data: payouts, error: payoutsError } = payoutsLookup;
    if (payoutsError) throw payoutsError;
    if (!payouts || payouts.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No payouts in this batch are pending payment'
      });
    }

    const payoutIds = payouts.map((row) => row.id);

    const { error: payoutUpdateError } = await supabase
      .from('payouts')
      .update({ status: 'PAID' })
      .in('id', payoutIds);

    if (payoutUpdateError) throw payoutUpdateError;

    const { error: batchUpdateError } = await supabase
      .from('payout_batches')
      .update({ status: 'PAID' })
      .eq('id', id);

    if (batchUpdateError) throw batchUpdateError;

    const participantIds = [...new Set(payouts.map((row) => row.participant_id).filter(Boolean))];
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

      if (appRes.error && !isMissingSchemaObjectError(appRes.error)) {
        throw appRes.error;
      }

      const latestAppIdByKey = new Map();
      for (const row of (appRes.data || [])) {
        const key = `${row.participant_id}::${row.project_id}::${row.product_id || ''}`;
        if (!latestAppIdByKey.has(key)) {
          latestAppIdByKey.set(key, row.id);
        }
      }

      const appIdsToComplete = [];
      for (const payout of payouts) {
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

        if (appUpdateError && !isMissingSchemaObjectError(appUpdateError)) {
          throw appUpdateError;
        }
      }
    }

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PAYOUT_BATCH_MARKED_PAID',
      entityType: 'PAYOUT_BATCH',
      entityId: id,
      message: `Payout batch ${id} marked as paid (${payoutIds.length} payouts)`
    });

    res.json({
      success: true,
      message: `Payout batch marked as paid (${payoutIds.length} payouts updated)`
    });
  } catch (err) {
    next(err);
  }
};

const backfillEligiblePayouts = async () => {
  // ── 1. Fetch all applications eligible for payout ─────────────────────────
  let appRes = await supabase
    .from('project_applications')
    .select('id, participant_id, project_id, product_id, allocated_budget, status')
    .in('status', ['APPROVED', 'PURCHASED']);
  if (appRes.error && !isMissingSchemaObjectError(appRes.error)) throw appRes.error;

  const applications = (appRes.data || []);
  if (!applications.length) return;

  const participantIds = [...new Set(applications.map(r => r.participant_id).filter(Boolean))];
  const projectIds     = [...new Set(applications.map(r => r.project_id).filter(Boolean))];
  const productIds     = [...new Set(applications.map(r => r.product_id).filter(Boolean))];

  if (!participantIds.length || !projectIds.length) return;

  // ── 2. Fetch projects (mode + reward) ─────────────────────────────────────
  const { data: projects, error: projErr } = await supabase
    .from('projects').select('id, mode, reward').in('id', projectIds);
  if (projErr) throw projErr;
  const projectMap = new Map((projects || []).map(p => [p.id, p]));

  // ── 3. Fetch product values ────────────────────────────────────────────────
  const { data: products } = productIds.length
    ? await supabase.from('project_products').select('id, product_value').in('id', productIds)
    : { data: [] };
  const productMap = new Map((products || []).map(p => [p.id, p]));

  // ── 4. Fetch ALL approved reviews for these participants ───────────────────
  const { data: allReviews } = await supabase
    .from('participant_reviews')
    .select('id, participant_id, project_id, allocation_id, status')
    .eq('status', 'APPROVED')
    .in('participant_id', participantIds);

  // ── 5. Fetch ALL approved proofs for these participants ────────────────────
  let proofRes = await supabase
    .from('purchase_proofs')
    .select('id, participant_id, allocation_id, status')
    .eq('status', 'APPROVED')
    .in('participant_id', participantIds);
  if (proofRes.error && /project_id/i.test(String(proofRes.error.message || ''))) {
    proofRes = await supabase
      .from('purchase_proofs')
      .select('id, participant_id, allocation_id, status')
      .eq('status', 'APPROVED')
      .in('participant_id', participantIds);
  }
  const allProofs = (proofRes.data || []);

  // ── 6. Fetch feedbacks ─────────────────────────────────────────────────────
  let feedbackRes = await supabase
    .from('internal_feedbacks')
    .select('id, participant_id, project_id, allocation_id')
    .in('participant_id', participantIds);
  if (feedbackRes.error && !isMissingSchemaObjectError(feedbackRes.error)) throw feedbackRes.error;
  const allFeedbacks = feedbackRes.data || [];

  // ── 7. Resolve allocation_id → project_id for reviews & proofs ────────────
  // CRITICAL FIX: fetch ALL allocations for these participants (not just by IDs from proofs)
  // This catches cases where proofs have allocation_ids that don't appear in a narrow lookup
  // because the allocation was completed, soft-deleted, or the IDs mismatched.
  const allAllocIds = [...new Set([
    ...(allReviews || []).map(r => r.allocation_id),
    ...allProofs.map(p => p.allocation_id),
    ...allFeedbacks.map(f => f.allocation_id),
  ].filter(Boolean))];

  let allocMap = new Map();
  // Fetch by IDs from proofs/reviews
  if (allAllocIds.length) {
    const { data: allocs } = await supabase
      .from('unit_allocations').select('id, project_id, participant_id').in('id', allAllocIds);
    for (const a of (allocs || [])) allocMap.set(a.id, a.project_id);
  }
  // ALSO fetch ALL allocations for these participants directly — catches completed allocations
  // whose IDs may not appear in narrow allAllocIds set
  if (participantIds.length) {
    const { data: participantAllocs } = await supabase
      .from('unit_allocations')
      .select('id, project_id, participant_id')
      .in('participant_id', participantIds)
      .in('project_id', projectIds);
    for (const a of (participantAllocs || [])) {
      if (!allocMap.has(a.id)) allocMap.set(a.id, a.project_id);
    }
  }

  // Build eligibility lookup: participantId::projectId → { hasReview, hasProof, proofId }
  const eligibilityMap = new Map(); // key → { hasReview, hasProof, proofId }
  const getOrCreate = (participantId, projectId) => {
    const key = `${participantId}::${projectId}`;
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
  for (const fb of allFeedbacks) {
    const pid = fb.project_id || allocMap.get(fb.allocation_id);
    if (pid) getOrCreate(fb.participant_id, pid).hasReview = true; // feedbacks count as review signal
  }

  // CRITICAL FIX: For any participant who has an approved proof but allocMap
  // didn't resolve their allocation_id to a project_id, do a direct fallback lookup.
  // This handles D2C participants whose proof allocation_id was not in allocMap.
  const proofParticipantsWithNoProject = allProofs.filter(p => !allocMap.get(p.allocation_id));
  if (proofParticipantsWithNoProject.length) {
    // For each such proof, find any approved application for this participant
    // and mark them eligible — the proof existence is sufficient for D2C
    for (const proof of proofParticipantsWithNoProject) {
      const participantApps = applications.filter(a => a.participant_id === proof.participant_id);
      for (const app of participantApps) {
        const project = projectMap.get(app.project_id);
        const mode = String(project?.mode || '').toUpperCase();
        if (mode !== 'MARKETPLACE') {
          // D2C: approved proof = eligible regardless of allocation resolution
          const entry = getOrCreate(proof.participant_id, app.project_id);
          entry.hasProof = true;
          if (!entry.proofId) entry.proofId = proof.id;
        }
      }
    }
  }

  // ── 8. Fetch existing payouts to skip already-covered products ────────────
  let existingPayoutsRes = await supabase
    .from('payouts')
    .select('id, participant_id, project_id, product_id, status')
    .in('participant_id', participantIds)
    .in('project_id', projectIds);

  if (existingPayoutsRes.error && /product_id/i.test(String(existingPayoutsRes.error.message || ''))) {
    existingPayoutsRes = await supabase
      .from('payouts')
      .select('id, participant_id, project_id, status')
      .in('participant_id', participantIds)
      .in('project_id', projectIds);
  }

  if (existingPayoutsRes.error) throw existingPayoutsRes.error;

  const existingPayouts = existingPayoutsRes.data || [];

  // Build covered set: participantId::projectId::productId when possible.
  // Older schemas may miss product_id; in that case fall back to participant::project.
  const coveredSet = new Set();
  for (const p of existingPayouts) {
    coveredSet.add(`${p.participant_id}::${p.project_id}::${p.product_id || ''}`);
    if (!('product_id' in p)) {
      coveredSet.add(`${p.participant_id}::${p.project_id}`);
    }
  }

  // ── 9. For each application, create ELIGIBLE payout if needed ─────────────
  const newPayouts = [];
  for (const app of applications) {
    const { participant_id: participantId, project_id: projectId, product_id: productId } = app;
    if (!participantId || !projectId) continue;

    const eligKey = `${participantId}::${projectId}`;
    const eligi = eligibilityMap.get(eligKey);
    if (!eligi) continue;

    const project = projectMap.get(projectId);
    const mode = String(project?.mode || '').toUpperCase();

    let isEligible = false;
    if (mode === 'MARKETPLACE') {
      isEligible = eligi.hasReview;
    } else {
      isEligible = eligi.hasProof || eligi.hasReview;
    }
    if (!isEligible) continue;

    const covKey = `${participantId}::${projectId}::${productId || ''}`;
    if (coveredSet.has(covKey)) continue;

    const rewardAmount = toAmount(project?.reward);
    // Always use product_value as the authoritative price. Only fall back to
    // allocated_budget when product_value is missing/zero (prevents accidental
    // override when admin set allocated_budget to a wrong value).
    const catalogueValue = toAmount(productMap.get(productId)?.product_value);
    const productAmount = catalogueValue > 0
      ? catalogueValue
      : toAmount(app.allocated_budget);

    newPayouts.push({
      participant_id: participantId,
      user_id: participantId,
      project_id: projectId,
      product_id: productId || null,
      purchase_proof_id: eligi.proofId || null,
      amount: rewardAmount + productAmount,
      status: 'ELIGIBLE',
    });
  }

  if (newPayouts.length > 0) {
    let { error: insertError } = await supabase
      .from('payouts')
      .insert(newPayouts);
    
    // If bulk insert fails because of missing columns, try a safer bulk insert or fallback
    if (insertError && isMissingSchemaObjectError(insertError)) {
      const isMissingProduct = /product_id/i.test(insertError.message);
      const isMissingUserId = /user_id/i.test(insertError.message);
      const isMissingProofId = /purchase_proof_id/i.test(insertError.message);

      if (isMissingProduct || isMissingUserId || isMissingProofId) {
        const saferPayouts = newPayouts.map(p => {
          const s = { ...p };
          if (isMissingProduct) delete s.product_id;
          if (isMissingUserId) delete s.user_id;
          if (isMissingProofId) delete s.purchase_proof_id;
          return s;
        });
        const retry = await supabase.from('payouts').insert(saferPayouts);
        insertError = retry.error;
      }
    }

    // Individual fallback if still failing
    if (insertError && isMissingSchemaObjectError(insertError)) {
      for (const p of newPayouts) {
        // Try different column combinations if schema is unknown
        const candidates = [
          { ...p },
          { ...p, user_id: undefined },
          { ...p, purchase_proof_id: undefined },
          { ...p, user_id: undefined, purchase_proof_id: undefined },
          { ...p, product_id: undefined, user_id: undefined, purchase_proof_id: undefined },
        ];
        for (const candidate of candidates) {
          const clean = Object.fromEntries(Object.entries(candidate).filter(([, v]) => v !== undefined));
          const { error } = await supabase.from('payouts').insert(clean);
          if (!error) break;
        }
      }
    } else if (insertError) {
      throw insertError;
    }
  }
};
const getPayoutReportRows = async ({ projectId = null, paidFilter = 'ALL' } = {}) => {
  let appRes = await supabase
    .from('project_applications')
    .select('id, participant_id, project_id, product_id, allocated_budget, status, created_at')
    .eq('status', 'APPROVED')
    .order('created_at', { ascending: false });

  if (appRes.error && /created_at/i.test(String(appRes.error.message || ''))) {
    appRes = await supabase
      .from('project_applications')
      .select('id, participant_id, project_id, product_id, allocated_budget, status')
      .eq('status', 'APPROVED');
  }
  if (appRes.error) throw appRes.error;

  let applications = appRes.data || [];
  if (projectId) {
    applications = applications.filter((row) => String(row.project_id) === String(projectId));
  }
  if (!applications.length) return [];

  const participantIds = [...new Set(applications.map((row) => row.participant_id).filter(Boolean))];
  const projectIds = [...new Set(applications.map((row) => row.project_id).filter(Boolean))];
  const productIds = [...new Set(applications.map((row) => row.product_id).filter(Boolean))];

  const [profilesRes, detailsRes, projectsRes, productsRes, payoutsRes] = await Promise.all([
    participantIds.length
      ? supabase.from('profiles').select('id, full_name, email').in('id', participantIds)
      : Promise.resolve({ data: [], error: null }),
    participantIds.length
      ? supabase.from('participant_details').select('participant_id, bank_account_name, bank_account_number, bank_ifsc, bank_name').in('participant_id', participantIds)
      : Promise.resolve({ data: [], error: null }),
    projectIds.length
      ? supabase.from('projects').select('id, title, name, reward').in('id', projectIds)
      : Promise.resolve({ data: [], error: null }),
    productIds.length
      ? supabase.from('project_products').select('id, name, product_value').in('id', productIds)
      : Promise.resolve({ data: [], error: null }),
    participantIds.length && projectIds.length
      ? supabase.from('payouts').select('id, participant_id, project_id, amount, status, payout_batch_id, created_at').in('participant_id', participantIds).in('project_id', projectIds)
      : Promise.resolve({ data: [], error: null })
  ]);

  if (profilesRes.error) throw profilesRes.error;
  if (detailsRes.error && !isMissingSchemaObjectError(detailsRes.error)) throw detailsRes.error;
  if (projectsRes.error) throw projectsRes.error;
  if (productsRes.error && !isMissingSchemaObjectError(productsRes.error)) throw productsRes.error;
  if (payoutsRes.error && !isMissingSchemaObjectError(payoutsRes.error)) throw payoutsRes.error;

  const profileMap = new Map((profilesRes.data || []).map((row) => [row.id, row]));
  const detailMap = new Map((detailsRes.data || []).map((row) => [row.participant_id, row]));
  const projectMap = new Map((projectsRes.data || []).map((row) => [row.id, row]));
  const productMap = new Map((productsRes.data || []).map((row) => [row.id, row]));

  const payoutMap = new Map();
  for (const payout of (payoutsRes.data || [])) {
    const key = `${payout.participant_id}::${payout.project_id}`;
    if (!payoutMap.has(key)) payoutMap.set(key, payout);
  }

  let rows = applications.map((app) => {
    const profile = profileMap.get(app.participant_id) || {};
    const details = detailMap.get(app.participant_id) || {};
    const project = projectMap.get(app.project_id) || {};
    const product = productMap.get(app.product_id) || {};
    const payout = payoutMap.get(`${app.participant_id}::${app.project_id}`) || null;
    const rewardAmount = Number(project.reward || 0);
    const productAmount = Number(app.allocated_budget || product.product_value || 0);
    const payoutStatus = String(payout?.status || 'NOT_ELIGIBLE').toUpperCase();

    return {
      payout_id: payout?.id || null,
      project_id: app.project_id,
      project_name: project.title || project.name || '-',
      participant_id: app.participant_id,
      participant_name: profile.full_name || '-',
      participant_email: profile.email || '-',
      product_id: app.product_id || null,
      product_name: product.name || '-',
      reward_amount: rewardAmount,
      product_amount: productAmount,
      payout_amount: Number(payout?.amount || rewardAmount + productAmount || 0),
      payout_status: payoutStatus,
      paid_status: payoutStatus === 'PAID' ? 'PAID' : 'NOT_PAID',
      payout_batch_id: payout?.payout_batch_id || null,
      bank_account_name: details.bank_account_name || '-',
      bank_account_number: details.bank_account_number || '-',
      bank_ifsc: details.bank_ifsc || '-',
      bank_name: details.bank_name || '-',
      created_at: payout?.created_at || app.created_at || null
    };
  });

  if (String(paidFilter || 'ALL').toUpperCase() === 'PAID') {
    rows = rows.filter((row) => row.paid_status === 'PAID');
  } else if (String(paidFilter || 'ALL').toUpperCase() === 'NOT_PAID') {
    rows = rows.filter((row) => row.paid_status === 'NOT_PAID');
  }

  return rows;
};

const getPayoutReport = async (req, res, next) => {
  try {
    await backfillEligiblePayouts();
    const projectId = req.query.projectId || null;
    const paidFilter = String(req.query.paid || 'ALL').toUpperCase();

    const rows = await getPayoutReportRows({ projectId, paidFilter });
    const summary = {
      total_rows: rows.length,
      total_amount: rows.reduce((sum, row) => sum + Number(row.payout_amount || 0), 0),
      paid_count: rows.filter((row) => row.paid_status === 'PAID').length,
      unpaid_count: rows.filter((row) => row.paid_status === 'NOT_PAID').length
    };

    res.json({
      success: true,
      data: rows,
      summary
    });
  } catch (err) {
    next(err);
  }
};

const exportPayoutReportCSV = async (req, res, next) => {
  try {
    await backfillEligiblePayouts();
    const projectId = req.query.projectId || null;
    const paidFilter = String(req.query.paid || 'ALL').toUpperCase();
    const rows = await getPayoutReportRows({ projectId, paidFilter });
    const fields = [
      'project_name',
      'product_name',
      'participant_name',
      'participant_email',
      'product_amount',
      'bank_account_name',
      'bank_account_number',
      'bank_ifsc',
      'bank_name',
      'payout_amount',
      'payout_status',
      'paid_status',
      'payout_batch_id',
      'created_at'
    ];
    const parser = new Parser({ fields });
    const csv = rows.length ? parser.parse(rows) : fields.join(',');
    res.header('Content-Type', 'text/csv');
    res.attachment(`payout_report_${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

/**
 * Export payout batch CSV
 */
const fetchPayoutExportRows = async ({ batchIds = [], payoutIds = [] } = {}) => {
  if (!batchIds.length && !payoutIds.length) return [];

  // ── 1. Fetch payout rows ──────────────────────────────────────────────────
  let payoutsRes;
  if (payoutIds.length) {
    payoutsRes = await supabase
      .from('payouts')
      .select('id, amount, status, payout_batch_id, participant_id, project_id, product_id')
      .in('id', payoutIds);
  } else {
    payoutsRes = await supabase
      .from('payouts')
      .select('id, amount, status, payout_batch_id, participant_id, project_id, product_id')
      .in('payout_batch_id', batchIds);
  }
  // schema-cache fallback — drop product_id if column missing
  if (payoutsRes.error && isMissingSchemaObjectError(payoutsRes.error)) {
    payoutsRes = payoutIds.length
      ? await supabase.from('payouts').select('id, amount, status, payout_batch_id, participant_id, project_id').in('id', payoutIds)
      : await supabase.from('payouts').select('id, amount, status, payout_batch_id, participant_id, project_id').in('payout_batch_id', batchIds);
  }
  if (payoutsRes.error) throw payoutsRes.error;
  const payouts = payoutsRes.data || [];
  if (!payouts.length) return [];

  const participantIds = [...new Set(payouts.map(r => r.participant_id).filter(Boolean))];
  const projectIds     = [...new Set(payouts.map(r => r.project_id).filter(Boolean))];
  const productIds     = [...new Set(payouts.map(r => r.product_id).filter(Boolean))];

  // ── 2. Participant profiles ───────────────────────────────────────────────
  const profilesRes = participantIds.length
    ? await supabase.from('profiles').select('id, full_name, email').in('id', participantIds)
    : { data: [], error: null };
  if (profilesRes.error) throw profilesRes.error;

  // ── 3. Bank details ───────────────────────────────────────────────────────
  let detailsRes = { data: [], error: null };
  if (participantIds.length) {
    detailsRes = await supabase
      .from('participant_details')
      .select('participant_id, bank_account_name, bank_account_number, bank_ifsc, bank_name')
      .in('participant_id', participantIds);
    if (detailsRes.error && !isMissingSchemaObjectError(detailsRes.error)) throw detailsRes.error;
  }

  // ── 4. Projects + brand profiles ─────────────────────────────────────────
  const projectsRes = projectIds.length
    ? await supabase.from('projects').select('id, title, name, created_by').in('id', projectIds)
    : { data: [], error: null };
  if (projectsRes.error) throw projectsRes.error;

  const brandIds = [...new Set((projectsRes.data || []).map(p => p.created_by).filter(Boolean))];
  let brandMap = new Map();
  if (brandIds.length) {
    const r = await supabase.from('profiles').select('id, full_name, email').in('id', brandIds);
    if (!r.error) brandMap = new Map((r.data || []).map(p => [p.id, p]));
  }

  // ── 5. Products (project_products table) ─────────────────────────────────
  let productMap = new Map();
  if (productIds.length) {
    const r = await supabase.from('project_products').select('id, name, product_value').in('id', productIds);
    if (!r.error) productMap = new Map((r.data || []).map(p => [p.id, p]));
  }

  // ── 6. Fallback product resolution via project_applications ──────────────
  //    (handles payouts where product_id column is NULL)
  const needsFallback = payouts.filter(p => !p.product_id && p.participant_id && p.project_id);
  const fallbackMap = new Map(); // "participantId::projectId" → { product, allocated_budget }
  if (needsFallback.length) {
    const fbPids  = [...new Set(needsFallback.map(p => p.participant_id))];
    const fbProjs = [...new Set(needsFallback.map(p => p.project_id))];
    const appRes  = await supabase
      .from('project_applications')
      .select('participant_id, project_id, product_id, allocated_budget')
      .in('participant_id', fbPids)
      .in('project_id', fbProjs)
      .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);
    if (!appRes.error && appRes.data) {
      const fbProductIds = [...new Set(appRes.data.map(a => a.product_id).filter(Boolean))];
      let fbProductMap = new Map();
      if (fbProductIds.length) {
        const pr = await supabase.from('project_products').select('id, name, product_value').in('id', fbProductIds);
        if (!pr.error) fbProductMap = new Map((pr.data || []).map(r => [r.id, r]));
      }
      for (const app of appRes.data) {
        const key = `${app.participant_id}::${app.project_id}`;
        if (!fallbackMap.has(key)) {
          fallbackMap.set(key, {
            product:          fbProductMap.get(app.product_id) || null,
            allocated_budget: Number(app.allocated_budget || 0),
          });
        }
      }
    }
  }

  // ── 7. Unit allocations: participant+project → allocation_id ─────────────
  //    Reviews and proofs are stored by allocation_id, so we need this bridge.
  let allocByParticipantProject = new Map(); // "participantId::projectId" → allocation_id
  if (participantIds.length && projectIds.length) {
    const r = await supabase
      .from('unit_allocations')
      .select('id, participant_id, project_id')
      .in('participant_id', participantIds)
      .in('project_id', projectIds);
    if (!r.error) {
      for (const a of (r.data || [])) {
        const key = `${a.participant_id}::${a.project_id}`;
        if (!allocByParticipantProject.has(key)) allocByParticipantProject.set(key, a.id);
      }
    }
  }

  const allAllocIds = [...allocByParticipantProject.values()];

  // ── 8. Purchase proofs (invoices) — fetched by allocation_id ─────────────
  let proofByAllocId = new Map(); // allocation_id → proof row
  if (allAllocIds.length) {
    // Try with product_id column first
    let r = await supabase
      .from('purchase_proofs')
      .select('id, allocation_id, participant_id, product_id, file_url, status')
      .in('allocation_id', allAllocIds);
    if (r.error && isMissingSchemaObjectError(r.error)) {
      r = await supabase
        .from('purchase_proofs')
        .select('id, allocation_id, participant_id, file_url, status')
        .in('allocation_id', allAllocIds);
    }
    if (!r.error) {
      for (const p of (r.data || [])) {
        // Prefer APPROVED proof; otherwise keep first found
        const existing = proofByAllocId.get(p.allocation_id);
        if (!existing || String(p.status || '').toUpperCase() === 'APPROVED') {
          proofByAllocId.set(p.allocation_id, p);
        }
      }
    }
  }

  // ── 9. Participant reviews — fetched by allocation_id + direct project_id ─
  let reviewByAllocId      = new Map(); // allocation_id → review row
  let reviewByParticipantProject = new Map(); // "participantId::projectId" → review row
  if (participantIds.length) {
    const r = await supabase
      .from('participant_reviews')
      .select('id, allocation_id, participant_id, project_id, review_text, review_url, status')
      .in('participant_id', participantIds);
    if (!r.error) {
      for (const rev of (r.data || [])) {
        // By allocation_id
        if (rev.allocation_id) {
          const existing = reviewByAllocId.get(rev.allocation_id);
          if (!existing || String(rev.status || '').toUpperCase() === 'APPROVED') {
            reviewByAllocId.set(rev.allocation_id, rev);
          }
        }
        // By participant+project (fallback when allocation_id is null on review row)
        if (rev.project_id) {
          const key = `${rev.participant_id}::${rev.project_id}`;
          const existing = reviewByParticipantProject.get(key);
          if (!existing || String(rev.status || '').toUpperCase() === 'APPROVED') {
            reviewByParticipantProject.set(key, rev);
          }
        }
      }
    }
  }

  // ── Build lookup maps ─────────────────────────────────────────────────────
  const profileMap = new Map((profilesRes.data || []).map(r => [r.id, r]));
  const detailMap  = new Map((detailsRes.data  || []).map(r => [r.participant_id, r]));
  const projectMap = new Map((projectsRes.data || []).map(r => [r.id, r]));

  // ── Assemble final rows ───────────────────────────────────────────────────
  return payouts.map((row) => {
    const ppKey   = `${row.participant_id}::${row.project_id}`;
    const allocId = allocByParticipantProject.get(ppKey) || null;

    // Product: direct product_id → project_products, else fallback via project_applications
    const directProduct  = productMap.get(row.product_id) || null;
    const fallback       = fallbackMap.get(ppKey) || null;
    const resolvedProduct = directProduct || fallback?.product || null;
    const productValue   = Number(
      resolvedProduct?.product_value ||
      fallback?.allocated_budget     ||
      row.amount || 0
    );

    // Invoice: look up proof by allocation_id
    const proof = allocId ? (proofByAllocId.get(allocId) || null) : null;

    // Review: by allocation_id first, then participant+project direct
    const review = (allocId ? reviewByAllocId.get(allocId) : null)
                || reviewByParticipantProject.get(ppKey)
                || null;

    const project = projectMap.get(row.project_id) || null;
    const brand   = project?.created_by ? (brandMap.get(project.created_by) || null) : null;

    return {
      ...row,
      product_amount: productValue,
      product_name:   resolvedProduct?.name || null,
      profiles: {
        ...(profileMap.get(row.participant_id) || {}),
        ...(detailMap.get(row.participant_id)  || {}),
      },
      projects:    project,
      brand_name:  brand?.full_name || brand?.email || null,
      review_text: review?.review_text || null,
      review_url:  review?.review_url  || null,
      invoice_url: proof?.file_url     || null,
    };
  });
}
const buildPayoutExportCsvRows = (payouts = []) => {
  return payouts.map((row) => {
    const profile = row?.profiles || {};
    return {
      brand_name:          row.brand_name  || null,
      participant_name:    profile.full_name || null,
      participant_email:   profile.email || null,
      project_title:       row?.projects?.title || row?.projects?.name || null,
      product_name:        row.product_name || null,
      product_value:       row.product_amount || row.amount || null,
      review_text:         row.review_text  || null,
      review_screenshot:   row.review_url   || null,
      invoice_url:         row.invoice_url  || null,
      account_holder_name: profile.bank_account_name || null,
      bank_account_number: profile.bank_account_number || null,
      bank_ifsc:           profile.bank_ifsc || null,
      bank_name:           profile.bank_name || null,
    };
  });
};

/* ── Export a single payout row (per participant) as CSV ── */
const exportPayoutCSV = async (req, res, next) => {
  try {
    const { payoutId } = req.params;

    const payouts = await fetchPayoutExportRows({ payoutIds: [payoutId] });
    if (!payouts.length) {
      return res.status(404).json({ success: false, message: 'Payout not found' });
    }

    const csvData = buildPayoutExportCsvRows(payouts);
    const fields = [
      'brand_name', 'participant_name', 'participant_email', 'project_title', 'product_name', 'product_value', 'review_text', 'review_screenshot', 'invoice_url', 'account_holder_name', 'bank_account_number', 'bank_ifsc', 'bank_name'
    ];
    const parser = new Parser({ fields });
    const csv = parser.parse(csvData);

    res.header('Content-Type', 'text/csv');
    res.attachment(`payout_${payoutId}.csv`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

/* ── Mark a single payout row as PAID (per participant) ── */
const markPayoutPaid = async (req, res, next) => {
  try {
    const { payoutId } = req.params;

    const { data: payout, error: lookupErr } = await supabase
      .from('payouts')
      .select('id, status, participant_id, project_id')
      .eq('id', payoutId)
      .maybeSingle();

    if (lookupErr) throw lookupErr;
    if (!payout) {
      return res.status(404).json({ success: false, message: 'Payout not found' });
    }
    if (normalizeStatus(payout.status) === 'PAID') {
      return res.status(400).json({ success: false, message: 'Payout is already marked as paid' });
    }

    const { error: updateErr } = await supabase
      .from('payouts')
      .update({ status: 'PAID' })
      .eq('id', payoutId);
    if (updateErr) throw updateErr;

    // If participant has a project_application, mark it COMPLETED
    if (payout.participant_id && payout.project_id) {
      await supabase
        .from('project_applications')
        .update({ status: 'COMPLETED' })
        .eq('participant_id', payout.participant_id)
        .eq('project_id', payout.project_id)
        .in('status', ['APPROVED', 'PURCHASED']);
    }

    res.json({ success: true, message: 'Payout marked as paid successfully' });
  } catch (err) {
    next(err);
  }
};

const exportPayoutBatchCSV = async (req, res, next) => {
  try {
    const { id } = req.params;

    const payouts = await fetchPayoutExportRows({ batchIds: [id] });

    if (!payouts.length) {
      return res.status(404).json({
        success: false,
        message: 'No payouts found for this batch'
      });
    }

    const csvData = buildPayoutExportCsvRows(payouts);
    const fields = [
      'brand_name',
      'participant_name',
      'participant_email',
      'project_title',
      'product_name',
      'product_value',
      'review_text',
      'review_screenshot',
      'invoice_url',
      'account_holder_name',
      'bank_account_number',
      'bank_ifsc',
      'bank_name'
    ];
    const parser = new Parser({ fields });
    const csv = parser.parse(csvData);

    await supabase
      .from('payout_batches')
      .update({ status: 'EXPORTED' })
      .eq('id', id)
      .neq('status', 'PAID');

    res.header('Content-Type', 'text/csv');
    res.attachment(`payout_batch_${id}.csv`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

const exportPayoutBatchesCSV = async (req, res, next) => {
  try {
    const statusFilter = normalizeStatus(req.query.status || 'ALL');
    const batchIdsQuery = String(req.query.batch_ids || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    let batchQuery = supabase
      .from('payout_batches')
      .select('id, status, created_at')
      .order('created_at', { ascending: false });

    if (batchIdsQuery.length) {
      batchQuery = batchQuery.in('id', batchIdsQuery);
    } else if (statusFilter === 'ACTIVE') {
      batchQuery = batchQuery.neq('status', 'PAID');
    } else if (statusFilter === 'IN_BATCH') {
      batchQuery = batchQuery.in('status', ['IN_BATCH', 'PENDING']);
    } else if (statusFilter !== 'ALL') {
      batchQuery = batchQuery.eq('status', statusFilter);
    }

    const { data: batches, error: batchError } = await batchQuery;
    if (batchError) throw batchError;

    const selectedBatchIds = (batches || []).map((row) => row.id).filter(Boolean);
    if (!selectedBatchIds.length) {
      return res.status(400).json({
        success: false,
        message: 'No payout batches found for the selected filter. Please create a batch first.'
      });
    }

    const payouts = await fetchPayoutExportRows({ batchIds: selectedBatchIds });
    if (!payouts.length) {
      return res.status(400).json({
        success: false,
        message: 'No payouts found in the selected batches.'
      });
    }

    const csvData = buildPayoutExportCsvRows(payouts);
    const fields = [
      'brand_name',
      'participant_name',
      'participant_email',
      'project_title',
      'product_name',
      'product_value',
      'review_text',
      'review_screenshot',
      'invoice_url',
      'account_holder_name',
      'bank_account_number',
      'bank_ifsc',
      'bank_name'
    ];
    const parser = new Parser({ fields });
    const csv = parser.parse(csvData);

    await supabase
      .from('payout_batches')
      .update({ status: 'EXPORTED' })
      .in('id', selectedBatchIds)
      .neq('status', 'PAID');

    const suffix = statusFilter === 'ALL' ? 'all' : statusFilter.toLowerCase();
    res.header('Content-Type', 'text/csv');
    res.attachment(`payout_batches_${suffix}_${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};


/**
 * Support tickets (Admin)
 */
const getAdminSupportTickets = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    const from = (page - 1) * limit;
    const to = from + Number(limit) - 1;

    let query = supabase
      .from('support_tickets')
      .select(
        `
        id,
        subject,
        message,
        status,
        created_at,
        profiles (
          id,
          full_name,
          email
        )
      `,
        { count: 'exact' }
      )
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data, count, error } = await query.range(from, to);
    if (error) throw error;

    res.json({
      success: true,
      data,
      meta: {
        page: Number(page),
        limit: Number(limit),
        total: count
      }
    });
  } catch (err) {
    next(err);
  }
};

const getAdminSupportTicketById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('support_tickets')
      .select(
        `
        id,
        subject,
        message,
        status,
        created_at,
        profiles (
          id,
          full_name,
          email
        )
      `
      )
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    res.json({
      success: true,
      data
    });
  } catch (err) {
    next(err);
  }
};

const updateSupportTicketStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['OPEN', 'CLOSED'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid ticket status'
      });
    }

    const { data, error } = await supabase
      .from('support_tickets')
      .update({ status })
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    res.json({
      success: true,
      message: `Ticket marked as ${status}`
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Analytics
 */
const getFunnelAnalytics = async (req, res, next) => {
  try {
    const [applied, approved, allocated, proofs, approvedProofs] =
      await Promise.all([
        supabase
          .from('project_applications')
          .select('id', { count: 'exact', head: true }),

        supabase
          .from('project_applications')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'APPROVED'),

        supabase
          .from('unit_allocations')
          .select('id', { count: 'exact', head: true }),

        supabase
          .from('purchase_proofs')
          .select('id', { count: 'exact', head: true }),

        supabase
          .from('purchase_proofs')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'APPROVED')
      ]);

    res.json({
      success: true,
      data: {
        applied: applied.count || 0,
        approved: approved.count || 0,
        allocated: allocated.count || 0,
        proofs_submitted: proofs.count || 0,
        proofs_approved: approvedProofs.count || 0
      }
    });
  } catch (err) {
    next(err);
  }
};

const getPayoutAnalytics = async (req, res, next) => {
  try {
    const [eligible, inBatch, totalAmount] = await Promise.all([
      supabase
        .from('payouts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'ELIGIBLE'),

      supabase
        .from('payouts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'IN_BATCH'),

      supabase.from('payouts').select('amount')
    ]);

    const total = (totalAmount.data || []).reduce(
      (sum, p) => sum + Number(p.amount),
      0
    );

    res.json({
      success: true,
      data: {
        eligible: eligible.count || 0,
        in_batch: inBatch.count || 0,
        total_amount: total
      }
    });
  } catch (err) {
    next(err);
  }
};

const getSupportAnalytics = async (req, res, next) => {
  try {
    const [open, closed] = await Promise.all([
      supabase
        .from('support_tickets')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'OPEN'),

      supabase
        .from('support_tickets')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'CLOSED')
    ]);

    res.json({
      success: true,
      data: {
        open: open.count || 0,
        closed: closed.count || 0
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * DEBUG: Trace why eligible payouts are not showing
 */
const debugPayouts = async (req, res, next) => {
  try {
    const debug = {};

    // 1. Check all applications and their statuses
    const { data: allApps, error: appErr } = await supabase
      .from('project_applications')
      .select('id, participant_id, project_id, product_id, allocated_budget, status')
      .order('status');
    debug.total_applications = allApps?.length || 0;
    debug.application_statuses = {};
    debug.application_error = appErr?.message || null;
    for (const app of (allApps || [])) {
      const s = app.status || 'null';
      debug.application_statuses[s] = (debug.application_statuses[s] || 0) + 1;
    }

    // 2. Check all payouts and their statuses
    const { data: allPayouts, error: payoutErr } = await supabase
      .from('payouts')
      .select('id, participant_id, project_id, product_id, amount, status, payout_batch_id');
    debug.total_payouts = allPayouts?.length || 0;
    debug.payout_statuses = {};
    debug.payout_error = payoutErr?.message || null;
    for (const p of (allPayouts || [])) {
      const s = p.status || 'null';
      debug.payout_statuses[s] = (debug.payout_statuses[s] || 0) + 1;
    }

    // 3. Check approved reviews
    const { data: approvedReviews, error: reviewErr } = await supabase
      .from('participant_reviews')
      .select('id, participant_id, project_id, allocation_id, status')
      .eq('status', 'APPROVED');
    debug.approved_reviews = approvedReviews?.length || 0;
    debug.review_error = reviewErr?.message || null;

    // 4. Check approved proofs
    let { data: approvedProofs, error: proofErr } = await supabase
      .from('purchase_proofs')
      .select('id, participant_id, allocation_id, status')
      .eq('status', 'APPROVED');
    if (proofErr && /project_id/i.test(String(proofErr.message || ''))) {
      const r2 = await supabase.from('purchase_proofs').select('id, participant_id, allocation_id, status').eq('status', 'APPROVED');
      approvedProofs = r2.data;
      proofErr = r2.error;
    }
    debug.approved_proofs = approvedProofs?.length || 0;
    debug.proof_error = proofErr?.message || null;

    // 5. Check projects and their modes
    const { data: projects, error: projErr } = await supabase
      .from('projects')
      .select('id, title, name, mode, reward');
    debug.projects = (projects || []).map(p => ({ id: p.id, name: p.title || p.name, mode: p.mode, reward: p.reward }));
    debug.project_error = projErr?.message || null;

    // 6. Run backfill and check what happens
    debug.backfill_apps_found = 0;
    debug.backfill_eligible_found = 0;
    const { data: backfillApps } = await supabase
      .from('project_applications')
      .select('id, participant_id, project_id, product_id, allocated_budget, status')
      .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);
    debug.backfill_apps_found = backfillApps?.length || 0;

    // 7. For each APPROVED/PURCHASED/COMPLETED app check eligibility
    const participantIds = [...new Set((backfillApps || []).map(a => a.participant_id).filter(Boolean))];
    const projectIds = [...new Set((backfillApps || []).map(a => a.project_id).filter(Boolean))];

    const { data: reviews2 } = await supabase
      .from('participant_reviews')
      .select('id, participant_id, project_id, allocation_id, status')
      .eq('status', 'APPROVED')
      .in('participant_id', participantIds);
    debug.reviews_for_apps = reviews2?.length || 0;

    let { data: proofs2 } = await supabase
      .from('purchase_proofs')
      .select('id, participant_id, allocation_id, status')
      .eq('status', 'APPROVED')
      .in('participant_id', participantIds);
    debug.proofs_for_apps = proofs2?.length || 0;

    // 8. Check unit_allocations for these participants
    const allAllocIds = [...new Set([
      ...(reviews2 || []).map(r => r.allocation_id),
      ...(proofs2 || []).map(p => p.allocation_id),
    ].filter(Boolean))];
    const { data: allocations2 } = await supabase
      .from('unit_allocations')
      .select('id, participant_id, project_id')
      .in('id', allAllocIds);
    debug.unit_allocations_found = allocations2?.length || 0;
    debug.allocation_ids_checked = allAllocIds;

    // 9. Check eligibility per app
    const allocToProject = new Map((allocations2 || []).map(a => [a.id, a.project_id]));
    const reviewByPair = new Map();
    for (const r of (reviews2 || [])) {
      const pid = r.project_id || allocToProject.get(r.allocation_id);
      const key = `${r.participant_id}::${pid}`;
      if (pid) reviewByPair.set(key, r);
    }
    const proofByPair = new Map();
    for (const p of (proofs2 || [])) {
      // proofs don't have project_id — find via allocation
      const pid = allocToProject.get(p.allocation_id);
      const key = `${p.participant_id}::${pid}`;
      if (pid) proofByPair.set(key, p);
    }

    debug.eligible_apps = [];
    debug.ineligible_reasons = [];
    for (const app of (backfillApps || [])) {
      const pairKey = `${app.participant_id}::${app.project_id}`;
      const hasReview = reviewByPair.has(pairKey);
      const hasProof = proofByPair.has(pairKey);
      const proj = (projects || []).find(p => p.id === app.project_id);
      const mode = String(proj?.mode || '').toUpperCase();
      let eligible = false;
      if (mode === 'MARKETPLACE') eligible = hasReview;
      else eligible = hasProof || hasReview;

      if (eligible) {
        debug.backfill_eligible_found++;
        debug.eligible_apps.push({ participant_id: app.participant_id, project_id: app.project_id, product_id: app.product_id, mode });
      } else {
        debug.ineligible_reasons.push({
          participant_id: app.participant_id,
          project_id: app.project_id,
          app_status: app.status,
          mode,
          hasReview,
          hasProof,
          pairKey
        });
      }
    }

    res.json({ success: true, debug });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
};

module.exports = {
  getPendingParticipants,
  approveParticipant,
  rejectParticipant,
  deleteParticipant,
  promoteParticipantToAdmin,
  removeAdminAccess,
  getAllParticipants,
  getAllAdmins,
  getParticipantById,
  getAdminDashboardSummary,
  getDashboardSummary,
  getAdminActivity,
  getApprovalsCount,
  getApprovals,
  getApplicationSummary,
  adminSearch,
  getPendingProjectAccessRequests,
  approveProjectAccessRequest,
  rejectProjectAccessRequest,
  getPendingProductApplications,
  approveProductApplication,
  rejectProductApplication,
  bulkDecideApplications,
  approvePurchaseProof,
  generatePayoutBatch,
  getEligiblePayouts,
  getPayoutReport,
  exportPayoutReportCSV,
  getPayoutBatches,
  markPayoutBatchPaid,
  exportPayoutBatchesCSV,
  exportPayoutBatchCSV,
  exportPayoutCSV,
  markPayoutPaid,
  getAdminSupportTickets,
  getAdminSupportTicketById,
  updateSupportTicketStatus,
  getFunnelAnalytics,
  getPayoutAnalytics,
  getSupportAnalytics,
  debugPayouts
};