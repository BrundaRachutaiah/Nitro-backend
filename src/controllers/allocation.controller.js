const supabase = require('../config/supabaseClient');

const RESERVATION_DAYS = 5;

/**
 * Allocate unit for an application (Admin)
 */
const allocateUnit = async (req, res, next) => {
  try {
    const { applicationId } = req.params;

    const { data: application } = await supabase
      .from('project_applications')
      .select('id, project_id, participant_id')
      .eq('id', applicationId)
      .maybeSingle();

    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    const { data: existingAllocation } = await supabase
      .from('unit_allocations')
      .select('id')
      .eq('project_id', application.project_id)
      .eq('participant_id', application.participant_id)
      .maybeSingle();

    if (existingAllocation) {
      return res.status(400).json({
        success: false,
        message: 'Unit already allocated for this participant'
      });
    }

    const { data: project } = await supabase
      .from('projects')
      .select('total_units')
      .eq('id', application.project_id)
      .maybeSingle();

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    const { count } = await supabase
      .from('unit_allocations')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', application.project_id)
      .eq('status', 'RESERVED');

    if (count >= project.total_units) {
      return res.status(400).json({
        success: false,
        message: 'All units are already allocated'
      });
    }

    const reservedUntil = new Date();
    reservedUntil.setDate(reservedUntil.getDate() + RESERVATION_DAYS);

    const { data, error } = await supabase
      .from('unit_allocations')
      .insert({
        project_id: application.project_id,
        participant_id: application.participant_id,
        reserved_until: reservedUntil.toISOString(),
        status: 'RESERVED'
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Unit allocated and reserved for 5 days',
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get my allocations (Participant)
 */
const getMyAllocations = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    const { data, error } = await supabase
      .from('unit_allocations')
      .select(
        `
        id,
        status,
        reserved_until,
        projects (
          id,
          name,
          mode
        )
      `
      )
      .eq('participant_id', participantId);

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

/**
 * Get active allocations
 */
const getActiveAllocations = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    const { data, error } = await supabase
      .from('unit_allocations')
      .select(
        `
        id,
        reserved_until,
        created_at,
        projects (
          id,
          title,
          reward
        )
      `
      )
      .eq('participant_id', participantId)
      .is('completed_at', null)
      .order('reserved_until', { ascending: true });

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
 * Get allocation by ID
 */
const getAllocationById = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { id } = req.params;

    const { data: allocation, error } = await supabase
      .from('unit_allocations')
      .select(
        `
        id,
        reserved_until,
        completed_at,
        created_at,
        projects (
          id,
          title,
          description,
          reward
        )
      `
      )
      .eq('id', id)
      .eq('participant_id', participantId)
      .maybeSingle();

    if (error) throw error;

    if (!allocation) {
      return res.status(404).json({
        success: false,
        message: 'Allocation not found'
      });
    }

    const { data: proof } = await supabase
      .from('purchase_proofs')
      .select('id, status, created_at')
      .eq('allocation_id', allocation.id)
      .eq('participant_id', participantId)
      .maybeSingle();

    let nextAction = 'NONE';

    if (!proof) {
      nextAction = 'UPLOAD_PURCHASE_PROOF';
    } else if (proof.status === 'REJECTED') {
      nextAction = 'REUPLOAD_PURCHASE_PROOF';
    } else if (proof.status === 'APPROVED') {
      nextAction = 'WAIT_FOR_PAYOUT';
    }

    res.json({
      success: true,
      data: {
        allocation,
        purchase_proof: proof || null,
        next_action: nextAction
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Update allocation status
 */
const updateAllocationStatus = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { id } = req.params;
    const { status } = req.body;

    if (status !== 'COMPLETED') {
      return res.status(400).json({
        success: false,
        message: 'Invalid status transition'
      });
    }

    const { data, error } = await supabase
      .from('unit_allocations')
      .update({ completed_at: new Date().toISOString() })
      .eq('id', id)
      .eq('participant_id', participantId)
      .is('completed_at', null)
      .select()
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Allocation not found or already completed'
      });
    }

    res.json({
      success: true,
      message: 'Allocation marked as completed'
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  allocateUnit,
  getMyAllocations,
  getActiveAllocations,
  getAllocationById,
  updateAllocationStatus
};
