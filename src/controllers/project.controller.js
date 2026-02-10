const supabase = require('../config/supabaseClient');
const {
  PROJECT_MODE,
  PROJECT_STATUS,
  APPLICATION_STATUS
} = require('../utils/constants');

/**
 * Create project (Admin)
 */
const createProject = async (req, res, next) => {
  try {
    const {
      name,
      mode,
      total_units,
      start_date,
      end_date
    } = req.body;

    if (!name || !mode || !total_units || !start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    if (![PROJECT_MODE.MARKETPLACE, PROJECT_MODE.D2C].includes(mode)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project mode'
      });
    }

    if (total_units <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Total units must be greater than 0'
      });
    }

    const startDate = new Date(start_date);
    const endDate = new Date(end_date);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format. Use YYYY-MM-DD'
      });
    }

    if (startDate >= endDate) {
      return res.status(400).json({
        success: false,
        message: 'Start date must be before end date'
      });
    }

    const { data, error } = await supabase
      .from('projects')
      .insert({
        name,
        mode,
        total_units,
        start_date,
        end_date,
        created_by: req.user.id
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Project created successfully',
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get all projects
 */
const getAllProjects = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .order('created_at', { ascending: false });

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
 * Get project by ID
 */
const getProjectById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

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
 * Update project (Admin)
 */
const updateProject = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, total_units, start_date, end_date } = req.body;

    const updates = {};
    if (name) updates.name = name;
    if (total_units) updates.total_units = total_units;
    if (start_date) updates.start_date = start_date;
    if (end_date) updates.end_date = end_date;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    const { data } = await supabase
      .from('projects')
      .update(updates)
      .eq('id', id)
      .select()
      .maybeSingle();

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    res.json({
      success: true,
      message: 'Project updated',
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Participant project lists
 */
const getAppliedProjects = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    const { data, error } = await supabase
      .from('project_applications')
      .select(
        `
        id,
        status,
        created_at,
        projects (
          id,
          title,
          reward,
          status
        )
      `
      )
      .eq('participant_id', participantId)
      .eq('status', APPLICATION_STATUS.PENDING);

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (err) {
    next(err);
  }
};

const getActiveProjects = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    const { data, error } = await supabase
      .from('unit_allocations')
      .select(
        `
        id,
        reserved_until,
        projects (
          id,
          title,
          reward,
          status
        )
      `
      )
      .eq('participant_id', participantId)
      .is('completed_at', null);

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (err) {
    next(err);
  }
};

const getCompletedProjects = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    const { data, error } = await supabase
      .from('unit_allocations')
      .select(
        `
        id,
        completed_at,
        projects (
          id,
          title,
          reward
        )
      `
      )
      .eq('participant_id', participantId)
      .not('completed_at', 'is', null);

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
 * Available projects
 */
const getAvailableProjects = async (req, res, next) => {
  try {
    const {
      category,
      reward_min,
      sort = 'newest',
      page = 1,
      limit = 10
    } = req.query;

    const from = (page - 1) * limit;
    const to = from + Number(limit) - 1;

    let query = supabase
      .from('projects')
      .select(
        'id, title, description, reward, category, created_at',
        { count: 'exact' }
      )
      .eq('status', PROJECT_STATUS.PUBLISHED);

    if (category) {
      query = query.eq('category', category);
    }

    if (reward_min) {
      query = query.gte('reward', Number(reward_min));
    }

    if (sort === 'reward') {
      query = query.order('reward', { ascending: false });
    } else {
      query = query.order('created_at', { ascending: false });
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

/**
 * Project summary with user context
 */
const getProjectSummary = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { id: projectId } = req.params;

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, title, description, reward, status')
      .eq('id', projectId)
      .maybeSingle();

    if (projectError) throw projectError;

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    const { data: application } = await supabase
      .from('project_applications')
      .select('id, status')
      .eq('project_id', projectId)
      .eq('participant_id', participantId)
      .maybeSingle();

    const { data: allocation } = await supabase
      .from('unit_allocations')
      .select('id, reserved_until, completed_at')
      .eq('project_id', projectId)
      .eq('participant_id', participantId)
      .maybeSingle();

    const { data: proof } = allocation
      ? await supabase
          .from('purchase_proofs')
          .select('id, status')
          .eq('allocation_id', allocation.id)
          .eq('participant_id', participantId)
          .maybeSingle()
      : { data: null };

    res.json({
      success: true,
      data: {
        project,
        user_context: {
          hasApplied: !!application,
          applicationStatus: application?.status || null,
          allocation: allocation || null,
          purchaseProofStatus: proof?.status || null
        }
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Admin project list
 */
const getAdminProjects = async (req, res, next) => {
  try {
    const { status, q, page = 1, limit = 10 } = req.query;

    const from = (page - 1) * limit;
    const to = from + Number(limit) - 1;

    let query = supabase
      .from('projects')
      .select(
        'id, title, status, mode, reward, created_at',
        { count: 'exact' }
      );

    if (status) {
      query = query.eq('status', status);
    }

    if (q) {
      query = query.ilike('title', `%${q}%`);
    }

    query = query.order('created_at', { ascending: false });

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

/**
 * Update project status (Admin)
 */
const updateProjectStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowed = [
      PROJECT_STATUS.DRAFT,
      PROJECT_STATUS.PUBLISHED,
      PROJECT_STATUS.ARCHIVED
    ];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project status'
      });
    }

    const { data, error } = await supabase
      .from('projects')
      .update({ status })
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    res.json({
      success: true,
      message: `Project status updated to ${status}`
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Admin project stats
 */
const getProjectStats = async (req, res, next) => {
  try {
    const { id } = req.params;

    const [applications, allocations, allocationIds] =
      await Promise.all([
        supabase
          .from('project_applications')
          .select('id', { count: 'exact', head: true })
          .eq('project_id', id),

        supabase
          .from('unit_allocations')
          .select('id', { count: 'exact', head: true })
          .eq('project_id', id),

        supabase
          .from('unit_allocations')
          .select('id')
          .eq('project_id', id)
      ]);

    if (applications.error) throw applications.error;
    if (allocations.error) throw allocations.error;
    if (allocationIds.error) throw allocationIds.error;

    const ids = (allocationIds.data || []).map(a => a.id);

    const [proofs, approvedProofs] = await Promise.all([
      ids.length
        ? supabase
            .from('purchase_proofs')
            .select('id', { count: 'exact', head: true })
            .in('allocation_id', ids)
            .eq('status', 'PENDING')
        : { count: 0 },

      ids.length
        ? supabase
            .from('purchase_proofs')
            .select('id', { count: 'exact', head: true })
            .in('allocation_id', ids)
            .eq('status', 'APPROVED')
        : { count: 0 }
    ]);

    if (proofs.error) throw proofs.error;
    if (approvedProofs.error) throw approvedProofs.error;

    res.json({
      success: true,
      data: {
        applications: applications.count || 0,
        allocations: allocations.count || 0,
        purchase_proofs: proofs.count || 0,
        approved_proofs: approvedProofs.count || 0
      }
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createProject,
  getAllProjects,
  getProjectById,
  updateProject,
  getAppliedProjects,
  getActiveProjects,
  getCompletedProjects,
  getAvailableProjects,
  getProjectSummary,
  getAdminProjects,
  updateProjectStatus,
  getProjectStats
};
