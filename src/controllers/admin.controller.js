const supabase = require('../config/supabaseClient');
const {
  buildDateRange,
  applyDateFilter
} = require('../utils/date.utils');
const { ALLOCATION_STATUS } = require('../utils/constants');
const { Parser } = require('json2csv');
const { sendEmail } = require('../services/email.service');
const { logActivity } = require('../services/activityLog.service');
const { calculatePayoutBreakdown } = require('../utils/payout.utils');
const {
  approvalEmail,
  purchaseApprovedEmail
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
    const allocatedBudget = toAmount(app.allocated_budget);
    const productAmount = allocatedBudget > 0 ? allocatedBudget : toAmount(productValueMap.get(app.product_id));
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
  preferredType = 'PRODUCT_APPLICATION_APPROVED'
} = {}) => {
  if (!participantId || !projectId) return;

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

  const latestByProduct = new Map();
  for (const row of rows) {
    if (!row.product_id) continue;
    if (!latestByProduct.has(row.product_id)) {
      latestByProduct.set(row.product_id, row);
    }
  }

  const productIds = [...latestByProduct.keys()];
  let productNameMap = new Map();
  if (productIds.length) {
    const { data: products, error: productsError } = await supabase
      .from('project_products')
      .select('id, name')
      .in('id', productIds);
    if (productsError && !isMissingSchemaObjectError(productsError)) throw productsError;
    productNameMap = new Map((products || []).map((row) => [row.id, row.name || row.id]));
  }

  const approved = [];
  const rejected = [];
  for (const row of latestByProduct.values()) {
    const name = productNameMap.get(row.product_id) || row.product_id;
    const status = String(row.status || '').toUpperCase();
    if (status === 'APPROVED') approved.push(name);
    if (status === 'REJECTED') rejected.push(name);
  }

  const approvedText = approved.length ? `Approved: ${approved.join(', ')}` : null;
  const rejectedText = rejected.length ? `Rejected: ${rejected.join(', ')}` : null;
  const summaryText = [approvedText, rejectedText].filter(Boolean).join(' | ');
  if (!summaryText) return;

  const { data: participantProfile } = await supabase
    .from('profiles')
    .select('id, full_name, email')
    .eq('id', participantId)
    .maybeSingle();

  await supabase
    .from('notifications')
    .insert({
      user_id: participantId,
      type: preferredType,
      title: 'Product request update',
      message: `${projectTitle || 'Project'}: ${summaryText}`
    });

  if (participantProfile?.email) {
    await sendEmail({
      to: participantProfile.email,
      subject: `Nitro product request update - ${projectTitle || 'Project'}`,
      html: `
        <p>Hi ${participantProfile.full_name || 'Participant'},</p>
        <p>Your product request status was updated.</p>
        <p><b>${projectTitle || 'Project'}</b>: ${summaryText}</p>
        <p>You can log in to Nitro to view details.</p>
      `
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

    if (data?.email) {
      sendEmail({
        to: data.email,
        subject: 'Nitro account approved',
        html: approvalEmail(data.full_name)
      });
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
      .select()
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
      .filter((app) => String(app.status || '').toUpperCase() === 'APPROVED')
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

    res.json({
      success: true,
      data: {
        participants_total: participantsTotal.count || 0,
        participants_approved: participantsApproved.count || 0,
        projects_active: projectsActive.count || 0,
        purchase_proofs_pending: purchaseProofsPending.count || 0,
        payouts_pending: payoutsPending.count || 0
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

    res.json({
      success: true,
      data: {
        participants_total: participantsTotal.count || 0,
        participants_approved: participantsApproved.count || 0,
        projects_active: projectsActive.count || 0,
        purchase_proofs_pending: purchaseProofsPending.count || 0,
        payouts_pending: payoutsPending.count || 0
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
      .select('id, project_id, participant_id')
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
      .eq('project_id', application.project_id)
      .eq('participant_id', application.participant_id)
      .is('completed_at', null)
      .limit(1)
      .maybeSingle();

    if (allocationLookup.error && /completed_at/i.test(String(allocationLookup.error.message || ''))) {
      allocationLookup = await supabase
        .from('unit_allocations')
        .select('id')
        .eq('project_id', application.project_id)
        .eq('participant_id', application.participant_id)
        .neq('status', ALLOCATION_STATUS.COMPLETED)
        .limit(1)
        .maybeSingle();

      if (allocationLookup.error && /status/i.test(String(allocationLookup.error.message || ''))) {
        allocationLookup = await supabase
          .from('unit_allocations')
          .select('id')
          .eq('project_id', application.project_id)
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
      reservedUntil.setDate(reservedUntil.getDate() + 5);

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
      preferredType: 'PRODUCT_APPLICATION_APPROVED'
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
      .select('id, participant_id, project_id, product_id')
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
      preferredType: 'PRODUCT_APPLICATION_REJECTED'
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
      if (projectMode === 'D2C') {
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
      .select('email')
      .eq('id', proofRow.participant_id)
      .maybeSingle();

    if (participant?.email) {
      sendEmail({
        to: participant.email,
        subject: 'Purchase proof approved',
        html: purchaseApprovedEmail()
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
      .select('id, participant_id, project_id, product_id, amount, status, created_at, payout_batch_id')
      .order('created_at', { ascending: true });

    if (filterProjectId) {
      payoutsQuery = payoutsQuery.eq('project_id', filterProjectId);
    }

    let payoutsRes = await payoutsQuery;

    let hasProductColumn = true;
    if (payoutsRes.error && /product_id/i.test(String(payoutsRes.error.message || ''))) {
      hasProductColumn = false;
      payoutsRes = await supabase
        .from('payouts')
        .select('id, participant_id, project_id, amount, status, created_at, payout_batch_id')
        .order('created_at', { ascending: true });
    }

    if (payoutsRes.error && /created_at/i.test(String(payoutsRes.error.message || ''))) {
      payoutsRes = await supabase
        .from('payouts')
        .select(hasProductColumn ? 'id, participant_id, project_id, product_id, amount, status, payout_batch_id' : 'id, participant_id, project_id, amount, status, payout_batch_id')
    }
    if (payoutsRes.error) throw payoutsRes.error;

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
      const appProductAmount = toAmount(app?.allocated_budget || app?.project_products?.product_value);
      const mappedProductAmount = product ? toAmount(product.product_value) : 0;
      const productAmount = appProductAmount || mappedProductAmount || toAmount(breakdown.productAmount);
      const computedTotal = rewardAmount + productAmount;
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

      // fallback if product_id or project_id column missing
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

    // Direct product_id from payouts (may be null for older rows)
    const directProductIds = [...new Set(payoutRows.map((row) => row.product_id).filter(Boolean))];

    let profilesRes = { data: [], error: null };
    let detailsRes = { data: [], error: null };
    let productsRes = { data: [], error: null };
    let applicationsRes = { data: [], error: null };

    // Fetch products directly linked on payout rows
    if (directProductIds.length) {
      productsRes = await supabase
        .from('project_products')
        .select('id, name, product_value')
        .in('id', directProductIds);
      if (productsRes.error && !isMissingSchemaObjectError(productsRes.error)) throw productsRes.error;
    }

    // Always fetch applications for ALL participants in this batch — covers both old rows
    // (no product_id on payout) and new rows (product_id set but we want product name anyway)
    if (participantIds.length) {
      let appRes = await supabase
        .from('project_applications')
        .select(`
          participant_id,
          project_id,
          allocated_budget,
          product_id,
          project_products ( id, name, product_value )
        `)
        .in('participant_id', participantIds)
        .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);
      if (appRes.error && !isMissingSchemaObjectError(appRes.error)) {
        // fallback without join if schema issue
        appRes = await supabase
          .from('project_applications')
          .select('participant_id, project_id, allocated_budget, product_id')
          .in('participant_id', participantIds)
          .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);
      }
      if (appRes.error && !isMissingSchemaObjectError(appRes.error)) throw appRes.error;
      applicationsRes = appRes;

      // Also fetch product names for product_ids found in applications
      const appProductIds = [...new Set((applicationsRes.data || []).map((r) => r.product_id).filter(Boolean))];
      const missingProductIds = appProductIds.filter((id) => !directProductIds.includes(id));
      if (missingProductIds.length) {
        const moreProductsRes = await supabase
          .from('project_products')
          .select('id, name, product_value')
          .in('id', missingProductIds);
        if (!moreProductsRes.error) {
          productsRes = {
            data: [...(productsRes.data || []), ...(moreProductsRes.data || [])],
            error: null
          };
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

    const profileMap = new Map((profilesRes.data || []).map((row) => [row.id, row]));
    const detailMap = new Map((detailsRes.data || []).map((row) => [row.participant_id, row]));
    const productMap = new Map((productsRes.data || []).map((row) => [row.id, row]));

    // Build application map: participant_id -> list of apps (each has product info)
    const appsByParticipant = new Map();
    for (const app of (applicationsRes.data || [])) {
      const pid = app.participant_id;
      if (!pid) continue;
      if (!appsByParticipant.has(pid)) appsByParticipant.set(pid, []);
      appsByParticipant.get(pid).push(app);
    }

    // Track which app index we've used per participant (to pair each payout row with next app)
    const appIndexByParticipant = new Map();

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

      // Resolve product name and amount
      let productName = null;
      let productAmount = null;

      // Strategy 1: product_id directly on payout row
      if (payout.product_id && productMap.has(payout.product_id)) {
        const prod = productMap.get(payout.product_id);
        productName = prod.name || null;
        productAmount = toAmount(prod.product_value);
      }

      // Strategy 2: match via project_id on payout → application
      if (!productName && payout.project_id) {
        const apps = appsByParticipant.get(participantId) || [];
        const matchedApp = apps.find((a) => a.project_id === payout.project_id);
        if (matchedApp) {
          productName = matchedApp?.project_products?.name
            || (matchedApp.product_id && productMap.get(matchedApp.product_id)?.name)
            || null;
          productAmount = toAmount(matchedApp?.allocated_budget || matchedApp?.project_products?.product_value
            || (matchedApp.product_id && productMap.get(matchedApp.product_id)?.product_value));
        }
      }

      // Strategy 3: sequential — take next unused application for this participant
      if (!productName) {
        const apps = appsByParticipant.get(participantId) || [];
        const idx = appIndexByParticipant.get(participantId) || 0;
        const app = apps[idx];
        if (app) {
          productName = app?.project_products?.name
            || (app.product_id && productMap.get(app.product_id)?.name)
            || null;
          productAmount = toAmount(app?.allocated_budget || app?.project_products?.product_value
            || (app.product_id && productMap.get(app.product_id)?.product_value));
          appIndexByParticipant.set(participantId, idx + 1);
        }
      }

      participantsByBatchId.get(batchId).push({
        id: participantId,
        payout_id: payout.id,
        payout_status: normalizeStatus(payout.status),
        full_name: profile.full_name || null,
        email: profile.email || null,
        product_name: productName,
        product_amount: productAmount,
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
  let appRes = await supabase
    .from('project_applications')
    .select('id, participant_id, project_id, product_id, allocated_budget, status, created_at')
    .in('status', ['APPROVED', 'PURCHASED'])
    .order('created_at', { ascending: false });

  if (appRes.error && /created_at/i.test(String(appRes.error.message || ''))) {
    appRes = await supabase
      .from('project_applications')
      .select('id, participant_id, project_id, product_id, allocated_budget, status')
      .in('status', ['APPROVED', 'PURCHASED']);
  }
  if (appRes.error && !isMissingSchemaObjectError(appRes.error)) throw appRes.error;

  const applications = (appRes.data || []).filter((row) => ['APPROVED', 'PURCHASED'].includes(normalizeStatus(row?.status)));
  if (!applications.length) return;

  const participantIds = [...new Set(applications.map((row) => row.participant_id).filter(Boolean))];
  const projectIds = [...new Set(applications.map((row) => row.project_id).filter(Boolean))];
  const productIds = [...new Set(applications.map((row) => row.product_id).filter(Boolean))];

  if (!participantIds.length || !projectIds.length) return;

  const projectsRes = await supabase
    .from('projects')
    .select('id, mode, reward')
    .in('id', projectIds);
  if (projectsRes.error) throw projectsRes.error;
  const projectMap = new Map((projectsRes.data || []).map((row) => [row.id, row]));

  const productsRes = productIds.length
    ? await supabase
        .from('project_products')
        .select('id, product_value')
        .in('id', productIds)
    : { data: [], error: null };
  if (productsRes.error && !isMissingSchemaObjectError(productsRes.error)) throw productsRes.error;
  const productMap = new Map((productsRes.data || []).map((row) => [row.id, row]));

  let approvedProofsRes = await supabase
    .from('purchase_proofs')
    .select('id, participant_id, project_id, allocation_id, status')
    .eq('status', 'APPROVED')
    .in('participant_id', participantIds);
  if (approvedProofsRes.error && /project_id/i.test(String(approvedProofsRes.error.message || ''))) {
    approvedProofsRes = await supabase
      .from('purchase_proofs')
      .select('id, participant_id, allocation_id, status')
      .eq('status', 'APPROVED')
      .in('participant_id', participantIds);
  }
  if (approvedProofsRes.error && !isMissingSchemaObjectError(approvedProofsRes.error)) throw approvedProofsRes.error;
  const approvedProofs = (approvedProofsRes.data || []).filter((row) => normalizeStatus(row?.status) === 'APPROVED');

  let approvedReviewsRes = await supabase
    .from('participant_reviews')
    .select('id, participant_id, project_id, allocation_id, status')
    .eq('status', 'APPROVED')
    .in('participant_id', participantIds);
  if (approvedReviewsRes.error && !isMissingSchemaObjectError(approvedReviewsRes.error)) throw approvedReviewsRes.error;
  const approvedReviews = (approvedReviewsRes.data || []).filter((row) => normalizeStatus(row?.status) === 'APPROVED');

  let feedbacksRes = await supabase
    .from('internal_feedbacks')
    .select('id, participant_id, project_id, allocation_id')
    .in('participant_id', participantIds);
  if (feedbacksRes.error && /project_id/i.test(String(feedbacksRes.error.message || ''))) {
    feedbacksRes = await supabase
      .from('internal_feedbacks')
      .select('id, participant_id, allocation_id')
      .in('participant_id', participantIds);
  }
  if (feedbacksRes.error && !isMissingSchemaObjectError(feedbacksRes.error)) throw feedbacksRes.error;
  const feedbacks = feedbacksRes.data || [];

  const allAllocationIds = [...new Set([
    ...approvedProofs.map((row) => row.allocation_id),
    ...approvedReviews.map((row) => row.allocation_id),
    ...feedbacks.map((row) => row.allocation_id)
  ].filter(Boolean))];

  const allocationsRes = allAllocationIds.length
    ? await supabase
        .from('unit_allocations')
        .select('id, participant_id, project_id')
        .in('id', allAllocationIds)
    : { data: [], error: null };
  if (allocationsRes.error && !isMissingSchemaObjectError(allocationsRes.error)) throw allocationsRes.error;

  const allocationToProject = new Map((allocationsRes.data || []).map((row) => [row.id, row.project_id]));
  const allocationToParticipant = new Map((allocationsRes.data || []).map((row) => [row.id, row.participant_id]));

  let payoutsRes = await supabase
    .from('payouts')
    .select('id, participant_id, project_id, product_id, status')
    .in('participant_id', participantIds)
    .in('project_id', projectIds);

  let hasPayoutProductColumn = true;
  if (payoutsRes.error && /product_id/i.test(String(payoutsRes.error.message || ''))) {
    hasPayoutProductColumn = false;
    payoutsRes = await supabase
      .from('payouts')
      .select('id, participant_id, project_id, status')
      .in('participant_id', participantIds)
      .in('project_id', projectIds);
  }
  if (payoutsRes.error && !isMissingSchemaObjectError(payoutsRes.error)) throw payoutsRes.error;

  const payoutMap = new Map();
  for (const row of (payoutsRes.data || [])) {
    const key = hasPayoutProductColumn
      ? `${row.participant_id}::${row.project_id}::${row.product_id || ''}`
      : `${row.participant_id}::${row.project_id}`;
    if (!payoutMap.has(key)) payoutMap.set(key, row);
  }

  const approvedProofByPair = new Map();
  for (const proof of approvedProofs) {
    const participantId = proof.participant_id || allocationToParticipant.get(proof.allocation_id);
    const projectId = proof.project_id || allocationToProject.get(proof.allocation_id);
    if (!participantId || !projectId) continue;
    const key = `${participantId}::${projectId}`;
    if (!approvedProofByPair.has(key)) approvedProofByPair.set(key, proof);
  }

  const approvedReviewByPair = new Map();
  for (const review of approvedReviews) {
    const participantId = review.participant_id || allocationToParticipant.get(review.allocation_id);
    const projectId = review.project_id || allocationToProject.get(review.allocation_id);
    if (!participantId || !projectId) continue;
    const key = `${participantId}::${projectId}`;
    if (!approvedReviewByPair.has(key)) approvedReviewByPair.set(key, review);
  }

  const feedbackByPair = new Set();
  for (const feedback of feedbacks) {
    const participantId = feedback.participant_id || allocationToParticipant.get(feedback.allocation_id);
    const projectId = feedback.project_id || allocationToProject.get(feedback.allocation_id);
    if (participantId && projectId) {
      feedbackByPair.add(`${participantId}::${projectId}`);
    }
  }

  for (const app of applications) {
    const participantId = app.participant_id;
    const projectId = app.project_id;
    if (!participantId || !projectId) continue;

    const pairKey = `${participantId}::${projectId}`;
    const payoutKey = hasPayoutProductColumn
      ? `${participantId}::${projectId}::${app.product_id || ''}`
      : pairKey;

    const existingPayout = payoutMap.get(payoutKey) || null;
    const currentStatus = normalizeStatus(existingPayout?.status);
    if (existingPayout && ['ELIGIBLE', 'IN_BATCH', 'EXPORTED', 'PAID'].includes(currentStatus)) {
      continue;
    }

    const project = projectMap.get(projectId);
    const mode = String(project?.mode || '').toUpperCase();
    const hasApprovedProof = approvedProofByPair.has(pairKey);
    const hasApprovedReview = approvedReviewByPair.has(pairKey);
    const hasFeedback = feedbackByPair.has(pairKey);

    let eligible = false;
    if (mode === 'MARKETPLACE') {
      eligible = hasApprovedReview || hasFeedback;
    } else {
      eligible = hasApprovedProof || hasApprovedReview;
    }
    if (!eligible) continue;

    const rewardAmount = toAmount(project?.reward);
    const productAmount = toAmount(app?.allocated_budget || productMap.get(app.product_id)?.product_value);
    const totalAmount = rewardAmount + productAmount;

    const proof = approvedProofByPair.get(pairKey);

    if (existingPayout) {
      const updatePayload = {
        amount: Number(totalAmount || 0),
        status: 'ELIGIBLE'
      };
      if (hasPayoutProductColumn) updatePayload.product_id = app.product_id || null;

      const { error: updateError } = await supabase
        .from('payouts')
        .update(updatePayload)
        .eq('id', existingPayout.id);

      if (updateError && !isMissingSchemaObjectError(updateError)) {
        throw updateError;
      }
      continue;
    }

    const payloadCandidates = [
      {
        participant_id: participantId,
        user_id: participantId,
        project_id: projectId,
        product_id: app.product_id || null,
        purchase_proof_id: proof?.id || null,
        amount: Number(totalAmount || 0),
        status: 'ELIGIBLE'
      },
      {
        participant_id: participantId,
        user_id: participantId,
        project_id: projectId,
        product_id: app.product_id || null,
        amount: Number(totalAmount || 0),
        status: 'ELIGIBLE'
      },
      {
        participant_id: participantId,
        project_id: projectId,
        product_id: app.product_id || null,
        purchase_proof_id: proof?.id || null,
        amount: Number(totalAmount || 0),
        status: 'ELIGIBLE'
      },
      {
        participant_id: participantId,
        project_id: projectId,
        product_id: app.product_id || null,
        amount: Number(totalAmount || 0),
        status: 'ELIGIBLE'
      },
      {
        participant_id: participantId,
        project_id: projectId,
        purchase_proof_id: proof?.id || null,
        amount: Number(totalAmount || 0),
        status: 'ELIGIBLE'
      },
      {
        participant_id: participantId,
        project_id: projectId,
        amount: Number(totalAmount || 0),
        status: 'ELIGIBLE'
      }
    ];

    let insertError = null;
    let inserted = false;
    for (const payload of payloadCandidates) {
      ({ error: insertError } = await supabase.from('payouts').insert(payload));
      if (!insertError) {
        inserted = true;
        break;
      }
      if (!isMissingSchemaObjectError(insertError)) {
        throw insertError;
      }
    }

    if (!inserted && insertError && !isMissingSchemaObjectError(insertError)) {
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
  if ((!batchIds.length) && (!payoutIds.length)) return [];

  let payoutsRes = await supabase
    .from('payouts')
    .select('id, amount, status, payout_batch_id, participant_id, project_id');

  if (payoutIds.length) {
    payoutsRes = await supabase
      .from('payouts')
      .select('id, amount, status, payout_batch_id, participant_id, project_id')
      .in('id', payoutIds);
  } else {
    payoutsRes = await supabase
      .from('payouts')
      .select('id, amount, status, payout_batch_id, participant_id, project_id')
      .in('payout_batch_id', batchIds);
  }

  if (payoutsRes.error && isMissingSchemaObjectError(payoutsRes.error)) {
    const fallbackQuery = payoutIds.length
      ? supabase.from('payouts').select('id, amount, status, payout_batch_id').in('id', payoutIds)
      : supabase.from('payouts').select('id, amount, status, payout_batch_id').in('payout_batch_id', batchIds);
    payoutsRes = await fallbackQuery;
  }
  if (payoutsRes.error) throw payoutsRes.error;
  const payouts = payoutsRes.data || [];

  const participantIds = [...new Set(payouts.map((row) => row.participant_id).filter(Boolean))];
  const projectIds = [...new Set(payouts.map((row) => row.project_id).filter(Boolean))];

  let profilesRes = { data: [], error: null };
  let detailsRes = { data: [], error: null };
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

  let projectsRes = { data: [], error: null };
  if (projectIds.length) {
    projectsRes = await supabase
      .from('projects')
      .select('id, title, name')
      .in('id', projectIds);
    if (projectsRes.error) throw projectsRes.error;
  }

  const profileMap = new Map((profilesRes.data || []).map((row) => [row.id, row]));
  const detailMap = new Map((detailsRes.data || []).map((row) => [row.participant_id, row]));
  const projectMap = new Map((projectsRes.data || []).map((row) => [row.id, row]));

  return payouts.map((row) => ({
    ...row,
    profiles: {
      ...(profileMap.get(row.participant_id) || {}),
      ...(detailMap.get(row.participant_id) || {})
    },
    projects: projectMap.get(row.project_id) || null
  }));
};

const buildPayoutExportCsvRows = (payouts = []) => {
  return payouts.map((row) => {
    const profile = row?.profiles || {};
    const addressParts = [
      profile.address_line1,
      profile.address_line2,
      profile.city,
      profile.state,
      profile.pincode,
      profile.country
    ].filter(Boolean);

    return {
      payout_batch_id: row.payout_batch_id || null,
      payout_id: row.id,
      participant_name: profile.full_name || null,
      participant_email: profile.email || null,
      account_holder_name: profile.bank_account_name || null,
      bank_account_number: profile.bank_account_number || null,
      bank_ifsc: profile.bank_ifsc || null,
      bank_name: profile.bank_name || null,
      participant_address: addressParts.join(', ') || null,
      project_title: row?.projects?.title || row?.projects?.name || null,
      amount: row.amount,
      status: row.status
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
      'payout_batch_id', 'payout_id', 'participant_name', 'participant_email',
      'account_holder_name', 'bank_account_number', 'bank_ifsc', 'bank_name',
      'participant_address', 'project_title', 'amount', 'status'
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
      'payout_batch_id',
      'payout_id',
      'participant_name',
      'participant_email',
      'account_holder_name',
      'bank_account_number',
      'bank_ifsc',
      'bank_name',
      'participant_address',
      'project_title',
      'amount',
      'status'
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
      'payout_batch_id',
      'payout_id',
      'participant_name',
      'participant_email',
      'account_holder_name',
      'bank_account_number',
      'bank_ifsc',
      'bank_name',
      'participant_address',
      'project_title',
      'amount',
      'status'
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
  getSupportAnalytics
};