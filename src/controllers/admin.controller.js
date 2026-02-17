const supabase = require('../config/supabaseClient');
const {
  buildDateRange,
  applyDateFilter
} = require('../utils/date.utils');
const { ALLOCATION_STATUS } = require('../utils/constants');
const { Parser } = require('json2csv');
const { sendEmail } = require('../services/email.service');
const { logActivity } = require('../services/activityLog.service');
const {
  approvalEmail,
  purchaseApprovedEmail
} = require('../services/email.templates');

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

    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', id)
      .eq('role', 'PARTICIPANT')
      .maybeSingle();

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Participant not found'
      });
    }

    res.json({ success: true, data });
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
    const [participants, purchaseProofs, payouts, projectAccessRequests, productApplications] = await Promise.all([
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
    const [participants, proofs, payouts] = await Promise.all([
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

    const finalSummary = {
      pending_total: loginSummary.pending_count + accessSummary.pending_count + productSummary.pending_count,
      total_requested: loginSummary.total_requested + accessSummary.total_requested + productSummary.total_requested,
      total_approved: loginSummary.approved_count + accessSummary.approved_count + productSummary.approved_count,
      total_rejected: loginSummary.rejected_count + accessSummary.rejected_count + productSummary.rejected_count
    };

    return res.json({
      success: true,
      data: {
        login_requests: loginSummary,
        project_unlock_requests: accessSummary,
        product_applications: productSummary,
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
    const { data: applications, error } = await supabase
      .from('project_applications')
      .select(
        `
        id,
        project_id,
        participant_id,
        product_id,
        status,
        created_at
      `
      )
      .in('status', requestedStatus === 'ALL' ? ['PENDING', 'APPROVED', 'REJECTED'] : [requestedStatus])
      .order('created_at', { ascending: true });

    if (error) throw error;

    const projectIds = [...new Set((applications || []).map((row) => row.project_id).filter(Boolean))];
    const participantIds = [...new Set((applications || []).map((row) => row.participant_id).filter(Boolean))];
    const productIds = [...new Set((applications || []).map((row) => row.product_id).filter(Boolean))];

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

    let projectProducts = [];
    if (productIds.length) {
      const { data: productRows, error: productError } = await supabase
        .from('project_products')
        .select('id, name, product_url, product_value')
        .in('id', productIds);
      if (productError) throw productError;
      projectProducts = productRows || [];
    }

    const projectMap = new Map(projects.map((item) => [item.id, item]));
    const profileMap = new Map(profiles.map((item) => [item.id, item]));
    const productMap = new Map(projectProducts.map((item) => [item.id, item]));

    const data = (applications || []).map((row) => ({
      ...row,
      projects: projectMap.get(row.project_id) || null,
      profiles: profileMap.get(row.participant_id) || null,
      project_products: productMap.get(row.product_id) || null
    }));

    res.json({
      success: true,
      data: data || []
    });
  } catch (err) {
    next(err);
  }
};

const approveProductApplication = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { allocated_budget, eligibility_notes } = req.body;

    const { data: application, error } = await supabase
      .from('project_applications')
      .update({
        status: 'APPROVED',
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString(),
        eligibility_notes: eligibility_notes || null,
        allocated_budget: Number(allocated_budget || 0)
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

    const { data: existingAllocation, error: allocationLookupError } = await supabase
      .from('unit_allocations')
      .select('id')
      .eq('project_id', application.project_id)
      .eq('participant_id', application.participant_id)
      .maybeSingle();

    if (allocationLookupError) throw allocationLookupError;

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

    await supabase
      .from('notifications')
      .insert({
        user_id: application.participant_id,
        type: 'PRODUCT_APPLICATION_APPROVED',
        title: 'Application approved',
        message: `Your product application was approved with allocated budget ₹${Number(allocated_budget || 0)}.`
      });

    res.json({
      success: true,
      message: 'Product application approved and allocation created'
    });

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PRODUCT_APPLICATION_APPROVED',
      entityType: 'PROJECT_APPLICATION',
      entityId: id,
      message: `Product application ${id} approved`
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
      .select('id, participant_id')
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Application not found or already processed'
      });
    }

    await supabase
      .from('notifications')
      .insert({
        user_id: data.participant_id,
        type: 'PRODUCT_APPLICATION_REJECTED',
        title: 'Application rejected',
        message: 'Your product application was rejected by admin.'
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

    if (!proof) {
      return res.status(404).json({
        success: false,
        message: 'Purchase proof not found or already processed'
      });
    }

    if (error) throw error;

    const { data: allocation, error: allocationError } = await supabase
      .from('unit_allocations')
      .select('project_id, participant_id, projects ( mode, reward )')
      .eq('id', proof.allocation_id)
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
          const { error: payoutError } = await supabase
            .from('payouts')
            .insert({
              participant_id: allocation.participant_id,
              project_id: allocation.project_id,
              purchase_proof_id: proof.id,
              amount: Number(allocation?.projects?.reward || 0),
              status: 'ELIGIBLE'
            });

          if (payoutError) throw payoutError;
          payoutCreated = true;
        }

        await supabase
          .from('unit_allocations')
          .update({ completed_at: new Date().toISOString() })
          .eq('id', proof.allocation_id)
          .eq('participant_id', allocation.participant_id)
          .is('completed_at', null);
      }
    }

    const { data: participant } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', proof.participant_id)
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

const getPayoutBatches = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const from = (Number(page) - 1) * Number(limit);
    const to = from + Number(limit) - 1;

    const { data, count, error } = await supabase
      .from('payout_batches')
      .select('id, total_amount, status, created_at, created_by', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;

    res.json({
      success: true,
      data: data || [],
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

/**
 * Export payout batch CSV
 */
const exportPayoutBatchCSV = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: payouts, error } = await supabase
      .from('payouts')
      .select(
        `
        id,
        amount,
        status,
        profiles (
          id,
          full_name,
          email
        ),
        projects (
          id,
          title
        )
      `
      )
      .eq('payout_batch_id', id);

    if (error) throw error;

    if (!payouts || payouts.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No payouts found for this batch'
      });
    }

    const csvData = payouts.map(p => ({
      payout_id: p.id,
      participant_name: p.profiles?.full_name,
      participant_email: p.profiles?.email,
      project_title: p.projects?.title,
      amount: p.amount,
      status: p.status
    }));

    const parser = new Parser();
    const csv = parser.parse(csvData);

    await supabase
      .from('payout_batches')
      .update({ status: 'EXPORTED' })
      .eq('id', id);

    res.header('Content-Type', 'text/csv');
    res.attachment(`payout_batch_${id}.csv`);
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
  getPayoutBatches,
  exportPayoutBatchCSV,
  getAdminSupportTickets,
  getAdminSupportTicketById,
  updateSupportTicketStatus,
  getFunnelAnalytics,
  getPayoutAnalytics,
  getSupportAnalytics
};
