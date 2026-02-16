const supabase = require('../config/supabaseClient');
const {
  buildDateRange,
  applyDateFilter
} = require('../utils/date.utils');
const { Parser } = require('json2csv');
const { sendEmail } = require('../services/email.service');
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
      .eq('status', 'PENDING')
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
 * Get all participants (Admin)
 */
const getAllParticipants = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, status, created_at')
      .eq('role', 'PARTICIPANT')
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

    res.json({
      success: true,
      data
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
    const participants = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'PARTICIPANT')
      .eq('status', 'PENDING');

    const purchaseProofs = await supabase
      .from('purchase_proofs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'PENDING');

    const payouts = await supabase
      .from('payout_batches')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'PENDING');

    const data = {
      participants: participants.count || 0,
      purchase_proofs: purchaseProofs.count || 0,
      payouts: payouts.count || 0
    };

    res.json({
      success: true,
      data: {
        ...data,
        total: data.participants + data.purchase_proofs + data.payouts
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

/**
 * Approve purchase proof + auto create payout
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

    const { data: allocation } = await supabase
      .from('unit_allocations')
      .select('project_id, participant_id')
      .eq('id', proof.allocation_id)
      .maybeSingle();

    if (allocation) {
      const { data: existingPayout } = await supabase
        .from('payouts')
        .select('id')
        .eq('participant_id', allocation.participant_id)
        .eq('project_id', allocation.project_id)
        .maybeSingle();

      if (!existingPayout) {
        const { error: payoutError } = await supabase
          .from('payouts')
          .insert({
            participant_id: allocation.participant_id,
            project_id: allocation.project_id,
            purchase_proof_id: proof.id,
            amount: 0,
            status: 'ELIGIBLE'
          });

        if (payoutError) throw payoutError;
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
      message: 'Purchase proof approved and payout eligibility created'
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
  promoteParticipantToAdmin,
  getAllParticipants,
  getAllAdmins,
  getParticipantById,
  getAdminDashboardSummary,
  getDashboardSummary,
  getAdminActivity,
  getApprovalsCount,
  getApprovals,
  adminSearch,
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
