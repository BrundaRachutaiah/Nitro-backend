const supabase = require('../config/supabaseClient');
const { logActivity } = require('../services/activityLog.service');
const {
  PROJECT_MODE,
  PROJECT_STATUS,
  APPLICATION_STATUS
} = require('../utils/constants');

const isMissingCompletedAtColumn = (error) =>
  /completed_at/i.test(String(error?.message || ''));

const isMissingStatusColumn = (error) =>
  /status/i.test(String(error?.message || ''));

const isMissingTableOrColumn = (error) => {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('does not exist')
    || message.includes('column')
    || message.includes('schema cache')
    || message.includes('relation')
    || message.includes('table')
  );
};

const attachCreatorNames = async (rows = []) => {
  const creatorIds = [...new Set(rows.map((item) => item?.created_by).filter(Boolean))];
  if (!creatorIds.length) return rows;

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, full_name, email')
    .in('id', creatorIds);

  if (error && !isMissingTableOrColumn(error)) throw error;

  const map = new Map((profiles || []).map((profile) => [
    profile.id,
    profile.full_name || profile.email || null
  ]));

  return rows.map((row) => ({
    ...row,
    created_by_name: map.get(row.created_by) || null
  }));
};

const toAmount = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

/**
 * Create project (Admin)
 */
const createProject = async (req, res, next) => {
  try {
    const {
      name,
      title,
      description,
      reward,
      category,
      mode,
      total_units,
      start_date,
      end_date,
      product_url,
      products = []
    } = req.body;

    if (
  !name ||
  !title ||
  !description ||
  !reward ||
  !category ||
  !mode ||
  !total_units ||
  !start_date ||
  !end_date
) {
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
        title,
        description,
        reward,
        category,
        mode,
        total_units,
        start_date,
        end_date,
        product_url: product_url || null,
        created_by: req.user.id
      })
      .select()
      .single();

    if (error) throw error;

    const { data: creatorProfile } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', req.user.id)
      .maybeSingle();

    const creatorLabel = creatorProfile?.full_name || creatorProfile?.email || req.user.id;

    if (Array.isArray(products) && products.length > 0) {
      const productRows = products
        .map((item) => ({
          project_id: data.id,
          name: String(item?.name || '').trim(),
          product_url: String(item?.product_url || '').trim(),
          image_url: String(item?.image_url || '').trim() || null,
          product_value: Number(item?.product_value || item?.price || 0)
        }))
        .filter((item) => item.name && item.product_url);

      if (productRows.length > 0) {
        const { error: productInsertError } = await supabase
          .from('project_products')
          .insert(productRows);

        if (productInsertError && !isMissingTableOrColumn(productInsertError)) {
          throw productInsertError;
        }
      }
    }

    res.status(201).json({
      success: true,
      message: 'Project created successfully',
      data
    });

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PROJECT_CREATED',
      entityType: 'PROJECT',
      entityId: data.id,
      message: `${creatorLabel} created project ${data.title || data.name || data.id}`
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
    const baseQuery = supabase
      .from('projects')
      .select('*')
      .order('created_at', { ascending: false });

    let query = baseQuery;
    if (req.user?.role === 'BRAND') query = query.eq('created_by', req.user.id);
    if (req.user?.role === 'PARTICIPANT') query = query.eq('status', PROJECT_STATUS.PUBLISHED);

    let { data, error } = await query;

    // Fallback for schemas where created_by or status does not exist yet.
    if (error && req.user?.role === 'BRAND') {
      ({ data, error } = await baseQuery);
    } else if (error && req.user?.role === 'PARTICIPANT') {
      ({ data, error } = await baseQuery);
    }

    if (error) throw error;

    const enrichedData = await attachCreatorNames(data || []);

    if (['ADMIN', 'SUPER_ADMIN'].includes(String(req.user?.role || '').toUpperCase())) {
      const projectIds = enrichedData.map((row) => row.id).filter(Boolean);

      if (projectIds.length) {
        const { data: approvedApps, error: approvedAppsError } = await supabase
          .from('project_applications')
          .select('project_id, product_id, allocated_budget, status')
          .in('project_id', projectIds)
          .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);
        if (approvedAppsError) throw approvedAppsError;

        const productIds = [...new Set((approvedApps || []).map((row) => row.product_id).filter(Boolean))];
        let products = [];
        if (productIds.length) {
          const { data: productRows, error: productError } = await supabase
            .from('project_products')
            .select('id, product_value')
            .in('id', productIds);
          if (productError && !isMissingTableOrColumn(productError)) throw productError;
          products = productRows || [];
        }

        const productValueMap = new Map((products || []).map((row) => [row.id, toAmount(row.product_value)]));
        const spentByProject = new Map();
        for (const row of (approvedApps || [])) {
          const amount = toAmount(row.allocated_budget) > 0
            ? toAmount(row.allocated_budget)
            : toAmount(productValueMap.get(row.product_id));
          if (!row.project_id || amount <= 0) continue;
          spentByProject.set(row.project_id, toAmount(spentByProject.get(row.project_id)) + amount);
        }

        const withBudgets = enrichedData.map((row) => {
          const allocatedBudget = toAmount(row.reward);
          const spentBudget = toAmount(spentByProject.get(row.id));
          return {
            ...row,
            allocated_budget: allocatedBudget,
            spent_budget: spentBudget,
            remaining_budget: Math.max(0, allocatedBudget - spentBudget)
          };
        });

        return res.json({
          success: true,
          data: withBudgets
        });
      }
    }

    res.json({
      success: true,
      data: enrichedData
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

    const baseQuery = supabase
      .from('projects')
      .select('*')
      .eq('id', id);

    let query = baseQuery;
    if (req.user?.role === 'BRAND') {
      query = query.eq('created_by', req.user.id);
    }

    if (req.user?.role === 'PARTICIPANT') {
      query = query.eq('status', PROJECT_STATUS.PUBLISHED);
    }

    let { data, error } = await query.maybeSingle();

    if (error && req.user?.role === 'BRAND') {
      ({ data, error } = await baseQuery.maybeSingle());
    }

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    if (error) throw error;

    const [enriched] = await attachCreatorNames([data]);

    res.json({
      success: true,
      data: enriched || data
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
    const {
      name,
      title,
      description,
      category,
      reward,
      mode,
      total_units,
      start_date,
      end_date,
      product_url,
      products
    } = req.body;

    const updates = {};
    if (typeof name === 'string' && name.trim()) updates.name = name.trim();
    if (typeof title === 'string' && title.trim()) updates.title = title.trim();
    if (typeof description === 'string') updates.description = description.trim();
    if (typeof category === 'string') updates.category = category.trim();
    if (reward !== undefined && reward !== null && reward !== '') updates.reward = Number(reward);
    if (typeof mode === 'string' && [PROJECT_MODE.MARKETPLACE, PROJECT_MODE.D2C].includes(mode)) {
      updates.mode = mode;
    }
    if (total_units !== undefined && total_units !== null && total_units !== '') {
      updates.total_units = Number(total_units);
    }
    if (typeof start_date === 'string' && start_date) updates.start_date = start_date;
    if (typeof end_date === 'string' && end_date) updates.end_date = end_date;
    if (typeof product_url === 'string') updates.product_url = product_url.trim() || null;

    if (updates.total_units !== undefined && Number(updates.total_units) <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Total units must be greater than 0'
      });
    }

    if (updates.start_date || updates.end_date) {
      const { data: existing, error: existingError } = await supabase
        .from('projects')
        .select('start_date, end_date')
        .eq('id', id)
        .maybeSingle();

      if (existingError) throw existingError;
      if (!existing) {
        return res.status(404).json({
          success: false,
          message: 'Project not found'
        });
      }

      const resolvedStartDate = updates.start_date || existing.start_date;
      const resolvedEndDate = updates.end_date || existing.end_date;

      const startDateObj = new Date(resolvedStartDate);
      const endDateObj = new Date(resolvedEndDate);

      if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime()) || startDateObj >= endDateObj) {
        return res.status(400).json({
          success: false,
          message: 'Start date must be before end date'
        });
      }
    }

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

    if (Array.isArray(products)) {
      const cleanedProducts = products
        .map((item) => ({
          project_id: id,
          name: String(item?.name || '').trim(),
          product_url: String(item?.product_url || '').trim(),
          image_url: String(item?.image_url || '').trim() || null,
          product_value: Number(item?.product_value || item?.price || 0)
        }))
        .filter((item) => item.name && item.product_url);

      const { error: deleteProductsError } = await supabase
        .from('project_products')
        .delete()
        .eq('project_id', id);

      if (deleteProductsError && !isMissingTableOrColumn(deleteProductsError)) {
        throw deleteProductsError;
      }

      if (cleanedProducts.length) {
        const { error: insertProductsError } = await supabase
          .from('project_products')
          .insert(cleanedProducts);

        if (insertProductsError && !isMissingTableOrColumn(insertProductsError)) {
          throw insertProductsError;
        }
      }
    }

    res.json({
      success: true,
      message: 'Project updated',
      data
    });

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PROJECT_UPDATED',
      entityType: 'PROJECT',
      entityId: id,
      message: `Project ${id} updated`
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
        project_id,
        product_id,
        allocated_budget,
        status,
        created_at,
        reviewed_at,
        projects (
          id,
          title,
          reward,
          status
        ),
        project_products (
          id,
          name,
          product_url,
          product_value
        )
      `
      )
      .eq('participant_id', participantId)
      .in('status', [APPLICATION_STATUS.PENDING, APPLICATION_STATUS.APPROVED, APPLICATION_STATUS.PURCHASED])
      .order('created_at', { ascending: false });

    if (error) throw error;

    const rows = data || [];
    const projectIds = [...new Set(rows.map((row) => row?.project_id).filter(Boolean))];

    let allocationRows = [];
    if (projectIds.length > 0) {
      let allocationRes = await supabase
        .from('unit_allocations')
        .select('id, project_id, status, reserved_until, created_at')
        .eq('participant_id', participantId)
        .in('project_id', projectIds)
        .is('completed_at', null)
        .order('created_at', { ascending: false });

      if (allocationRes.error && /completed_at/i.test(String(allocationRes.error.message || ''))) {
        allocationRes = await supabase
          .from('unit_allocations')
          .select('id, project_id, status, reserved_until, created_at')
          .eq('participant_id', participantId)
          .in('project_id', projectIds)
          .neq('status', 'COMPLETED')
          .order('reserved_until', { ascending: false });
      }

      if (allocationRes.error && /status/i.test(String(allocationRes.error.message || ''))) {
        allocationRes = await supabase
          .from('unit_allocations')
          .select('id, project_id, status, reserved_until, created_at')
          .eq('participant_id', participantId)
          .in('project_id', projectIds)
          .order('created_at', { ascending: false });
      }

      if (allocationRes.error && isMissingTableOrColumn(allocationRes.error)) {
        allocationRes = await supabase
          .from('unit_allocations')
          .select('id, project_id, status, reserved_until')
          .eq('participant_id', participantId)
          .in('project_id', projectIds)
          .order('reserved_until', { ascending: false });
      }

      if (allocationRes.error && !isMissingTableOrColumn(allocationRes.error)) {
        throw allocationRes.error;
      }

      allocationRows = (allocationRes.data || []).map((row) => ({
        ...row,
        created_at: row.created_at || null
      }));
    }

    const latestAllocationByProject = new Map();
    for (const allocation of allocationRows) {
      if (!latestAllocationByProject.has(allocation.project_id)) {
        latestAllocationByProject.set(allocation.project_id, allocation);
      }
    }

    const enriched = rows.map((row) => {
      const allocation = latestAllocationByProject.get(row.project_id) || null;
      return {
        ...row,
        allocation: allocation
          ? {
              id: allocation.id,
              status: allocation.status || null,
              reserved_until: allocation.reserved_until || null
            }
          : null
      };
    });

    res.json({
      success: true,
      data: enriched
    });
  } catch (err) {
    next(err);
  }
};

const getActiveProjects = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    const baseQuery = () =>
      supabase
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
        .eq('participant_id', participantId);

    let { data, error } = await baseQuery().is('completed_at', null);

    if (error && isMissingCompletedAtColumn(error)) {
      ({ data, error } = await baseQuery().neq('status', 'COMPLETED'));

      if (error && isMissingStatusColumn(error)) {
        ({ data, error } = await baseQuery());
      }
    }

    if (error) throw error;

    const projectIds = [...new Set((data || []).map((row) => row?.projects?.id).filter(Boolean))];
    let approvedApplications = [];
    if (projectIds.length > 0) {
      const { data: applications, error: applicationsError } = await supabase
        .from('project_applications')
        .select(
          `
          id,
          project_id,
          allocated_budget,
          status,
          product_id,
          project_products (
            id,
            name,
            product_url,
            product_value
          )
        `
        )
        .eq('participant_id', participantId)
        .in('project_id', projectIds)
        .eq('status', 'APPROVED')
        .order('reviewed_at', { ascending: false });

      if (applicationsError && !isMissingTableOrColumn(applicationsError)) {
        throw applicationsError;
      }
      approvedApplications = applications || [];
    }

    const appByProject = new Map();
    for (const row of approvedApplications) {
      if (!appByProject.has(row.project_id)) {
        appByProject.set(row.project_id, row);
      }
    }

    const enriched = (data || []).map((row) => {
      const projectId = row?.projects?.id;
      const app = appByProject.get(projectId);
      return {
        ...row,
        allocated_budget: app?.allocated_budget || 0,
        selected_product: app?.project_products || null
      };
    });

    res.json({
      success: true,
      data: enriched
    });
  } catch (err) {
    next(err);
  }
};

const getCompletedProjects = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    let appRes = await supabase
      .from('project_applications')
      .select(
        `
        id,
        project_id,
        product_id,
        allocated_budget,
        status,
        reviewed_at,
        created_at,
        projects (
          id,
          title,
          reward,
          status
        ),
        project_products (
          id,
          name,
          product_url,
          product_value
        )
      `
      )
      .eq('participant_id', participantId)
      .eq('status', APPLICATION_STATUS.COMPLETED)
      .order('reviewed_at', { ascending: false })
      .order('created_at', { ascending: false });

    if (appRes.error && /reviewed_at|created_at/i.test(String(appRes.error.message || ''))) {
      appRes = await supabase
        .from('project_applications')
        .select(
          `
          id,
          project_id,
          product_id,
          allocated_budget,
          status,
          projects (
            id,
            title,
            reward,
            status
          ),
          project_products (
            id,
            name,
            product_url,
            product_value
          )
        `
        )
        .eq('participant_id', participantId)
        .eq('status', APPLICATION_STATUS.COMPLETED);
    }

    if (appRes.error && !isMissingTableOrColumn(appRes.error)) {
      throw appRes.error;
    }

    const data = (appRes.data || []).map((row) => ({
      ...row,
      completed_at: row.reviewed_at || row.created_at || null
    }));

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
    const participantId = req.user.id;
    const {
      category,
      mode,
      q,
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
        'id, title, description, reward, category, mode, status, created_at',
        { count: 'exact' }
      )
      .eq('status', PROJECT_STATUS.PUBLISHED);

    if (mode && [PROJECT_MODE.MARKETPLACE, PROJECT_MODE.D2C].includes(mode.toUpperCase())) {
      query = query.eq('mode', mode.toUpperCase());
    }

    if (category) {
      query = query.eq('category', category);
    }

    if (q) {
      query = query.ilike('title', `%${q}%`);
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

    let filtered = data || [];
    if (participantId) {
      const { data: applications, error: applicationsError } = await supabase
        .from('project_applications')
        .select('project_id')
        .eq('participant_id', participantId);

      if (applicationsError && !isMissingTableOrColumn(applicationsError)) {
        throw applicationsError;
      }

      const appliedProjectIds = new Set((applications || []).map((row) => row.project_id));
      filtered = filtered.filter((item) => !appliedProjectIds.has(item.id));
    }

    res.json({
      success: true,
      data: filtered,
      meta: {
        page: Number(page),
        limit: Number(limit),
        total: filtered.length
      }
    });
  } catch (err) {
    next(err);
  }
};

const getActiveCatalog = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { mode, q } = req.query;

    const nowIso = new Date().toISOString();

    let query = supabase
      .from('projects')
      .select('id, name, title, description, reward, total_units, category, mode, status, start_date, end_date, product_url, created_by, created_at')
      .eq('status', PROJECT_STATUS.PUBLISHED)
      .or(`start_date.is.null,start_date.lte.${nowIso}`)
      .or(`end_date.is.null,end_date.gte.${nowIso}`)
      .order('created_at', { ascending: false });

    if (mode && [PROJECT_MODE.MARKETPLACE, PROJECT_MODE.D2C].includes(String(mode).toUpperCase())) {
      query = query.eq('mode', String(mode).toUpperCase());
    }

    if (q) {
      query = query.ilike('title', `%${q}%`);
    }

    const { data: projects, error } = await query;
    if (error) throw error;

    let accessRows = [];
    const accessRes = await supabase
      .from('project_access_requests')
      .select('project_id, status')
      .eq('participant_id', participantId);

    if (!accessRes.error) {
      accessRows = accessRes.data || [];
    } else if (!isMissingTableOrColumn(accessRes.error)) {
      throw accessRes.error;
    }

    const accessMap = new Map(accessRows.map((row) => [row.project_id, row.status]));
    const withCreatorName = await attachCreatorNames(projects || []);
    const projectIds = (withCreatorName || []).map((project) => project.id).filter(Boolean);

    let productRows = [];
    if (projectIds.length) {
      let productRes = await supabase
        .from('project_products')
        .select('id, project_id, name, product_url, is_active')
        .in('project_id', projectIds);

      if (productRes.error && /is_active/i.test(String(productRes.error.message || ''))) {
        productRes = await supabase
          .from('project_products')
          .select('id, project_id, name, product_url')
          .in('project_id', projectIds);
      }

      if (productRes.error && !isMissingTableOrColumn(productRes.error)) {
        throw productRes.error;
      }

      productRows = productRes.data || [];
    }

    const productCountByProject = new Map();
    for (const row of productRows) {
      const projectId = row.project_id;
      if (!projectId) continue;
      if (Object.prototype.hasOwnProperty.call(row, 'is_active') && row.is_active !== true) continue;
      if (!String(row.name || '').trim()) continue;
      if (!String(row.product_url || '').trim()) continue;
      productCountByProject.set(projectId, (productCountByProject.get(projectId) || 0) + 1);
    }

    const enriched = (withCreatorName || []).map((project) => ({
      ...project,
      access_status: accessMap.get(project.id) || null,
      product_count: Number(productCountByProject.get(project.id) || 0),
      has_products: Number(productCountByProject.get(project.id) || 0) > 0
    }));

    res.json({
      success: true,
      data: enriched
    });
  } catch (err) {
    next(err);
  }
};

const getMyProjectAccessRequests = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    const { data, error } = await supabase
      .from('project_access_requests')
      .select(
        `
        id,
        project_id,
        status,
        created_at,
        reviewed_at,
        projects (
          id,
          title,
          name,
          mode
        )
      `
      )
      .eq('participant_id', participantId)
      .order('created_at', { ascending: false });

    if (error && isMissingTableOrColumn(error)) {
      return res.json({
        success: true,
        data: []
      });
    }

    if (error) throw error;

    res.json({
      success: true,
      data: data || []
    });
  } catch (err) {
    next(err);
  }
};

const requestProjectAccess = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { id: projectId } = req.params;

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, title, status')
      .eq('id', projectId)
      .maybeSingle();

    if (projectError) throw projectError;
    if (!project || String(project.status || '').toLowerCase() !== PROJECT_STATUS.PUBLISHED) {
      return res.status(404).json({
        success: false,
        message: 'Active project not found'
      });
    }

    // Fetch all active products — treat is_active NULL as active for backwards compat

    const { data: existing, error: existingError } = await supabase
      .from('project_access_requests')
      .select('id, status')
      .eq('project_id', projectId)
      .eq('participant_id', participantId)
      .maybeSingle();

    if (existingError && !isMissingTableOrColumn(existingError)) throw existingError;

    if (existing) {
      return res.json({
        success: true,
        message: `Access request already ${String(existing.status || '').toLowerCase()}`,
        data: existing
      });
    }

    if (isMissingTableOrColumn(existingError)) {
      return res.status(400).json({
        success: false,
        message: 'project_access_requests table not found. Run latest SQL migration.'
      });
    }

    const { data, error } = await supabase
      .from('project_access_requests')
      .insert({
        project_id: projectId,
        participant_id: participantId,
        status: 'PENDING'
      })
      .select('id, status, project_id')
      .single();

    if (error) throw error;

    const { data: participantProfile } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', participantId)
      .maybeSingle();

    const participantLabel = participantProfile?.full_name || participantProfile?.email || participantId;

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PROJECT_ACCESS_REQUESTED',
      entityType: 'PROJECT_ACCESS_REQUEST',
      entityId: data.id,
      message: `${participantLabel} requested unlock for project ${project.title || projectId}`
    });

    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['ADMIN', 'SUPER_ADMIN'])
      .eq('status', 'APPROVED');

    if (admins?.length) {
      const notifications = admins.map((admin) => ({
        user_id: admin.id,
        type: 'PROJECT_ACCESS_REQUEST',
        title: 'Project access request',
        message: `Participant requested access to project ${project.title || projectId}`
      }));
      await supabase.from('notifications').insert(notifications);
    }

    res.status(201).json({
      success: true,
      message: 'Access request sent to admin',
      data
    });
  } catch (err) {
    next(err);
  }
};

const getProjectProductsForParticipant = async (req, res, next) => {
  try {
    const { id: projectId } = req.params;

    // Only check that the project is published — no access-request gate needed
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, status')
      .eq('id', projectId)
      .maybeSingle();
    if (projectError) throw projectError;
    if (!project || String(project.status || '').toLowerCase() !== PROJECT_STATUS.PUBLISHED) {
      return res.status(404).json({
        success: false,
        message: 'Active project not found'
      });
    }

    // Fetch products — treat is_active NULL as active for backwards compatibility
    let productRes = await supabase
      .from('project_products')
      .select('id, name, product_url, image_url, product_value, is_active, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    // Fallback if is_active column does not exist in DB
    if (productRes.error && /is_active/i.test(String(productRes.error.message || ''))) {
      productRes = await supabase
        .from('project_products')
        .select('id, name, product_url, image_url, product_value, created_at')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false });
    }

    if (productRes.error && !isMissingTableOrColumn(productRes.error)) throw productRes.error;

    // Only exclude products explicitly set to false — null counts as active
    const products = (productRes.data || []).filter((p) => {
      if (Object.prototype.hasOwnProperty.call(p, 'is_active') && p.is_active === false) return false;
      return true;
    });

    res.json({
      success: true,
      data: {
        access_status: 'PUBLIC',
        products
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

    let { data: allocation } = await supabase
      .from('unit_allocations')
      .select('id, reserved_until, completed_at')
      .eq('project_id', projectId)
      .eq('participant_id', participantId)
      .maybeSingle();

    if (!allocation) {
      const fallback = await supabase
        .from('unit_allocations')
        .select('id, reserved_until')
        .eq('project_id', projectId)
        .eq('participant_id', participantId)
        .maybeSingle();

      allocation = fallback.data
        ? { ...fallback.data, completed_at: null }
        : null;
    }

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

    const enrichedData = await attachCreatorNames(data || []);

    res.json({
      success: true,
      data: enrichedData,
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

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PROJECT_STATUS_UPDATED',
      entityType: 'PROJECT',
      entityId: id,
      message: `Project ${id} status updated to ${status}`
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
  getActiveCatalog,
  requestProjectAccess,
  getProjectProductsForParticipant,
  getAppliedProjects,
  getActiveProjects,
  getCompletedProjects,
  getAvailableProjects,
  getProjectSummary,
  getMyProjectAccessRequests,
  getAdminProjects,
  updateProjectStatus,
  getProjectStats
};
