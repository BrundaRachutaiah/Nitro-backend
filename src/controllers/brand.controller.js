const supabase = require('../config/supabaseClient');

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

const getBrandProjects = async (req, res, next) => {
  try {
    const queryWithProducts = () => supabase
      .from('projects')
      .select(
        `
        id,
        title,
        name,
        description,
        category,
        mode,
        status,
        reward,
        total_units,
        start_date,
        end_date,
        created_at,
        created_by,
        project_products (
          id,
          name,
          product_url,
          product_value,
          is_active,
          created_at
        )
      `
      )
      .order('created_at', { ascending: false });

    const queryWithoutProducts = () => supabase
      .from('projects')
      .select('id, title, name, description, category, mode, status, reward, total_units, start_date, end_date, created_at, created_by')
      .order('created_at', { ascending: false });

    let query = queryWithProducts();

    if (req.user?.role === 'BRAND') {
      query = query.eq('created_by', req.user.id);
    }

    let { data, error } = await query;

    if (error && isMissingSchemaObjectError(error)) {
      let fallbackQuery = queryWithoutProducts();
      if (req.user?.role === 'BRAND') {
        fallbackQuery = fallbackQuery.eq('created_by', req.user.id);
      }
      ({ data, error } = await fallbackQuery);
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

const getBrandAnalytics = async (req, res, next) => {
  try {
    if (req.user?.role !== 'BRAND') {
      const [projects, applications, allocations] = await Promise.all([
        supabase.from('projects').select('id', { count: 'exact', head: true }),
        supabase.from('project_applications').select('id', { count: 'exact', head: true }),
        supabase.from('unit_allocations').select('id', { count: 'exact', head: true })
      ]);

      if (projects.error) throw projects.error;
      if (applications.error) throw applications.error;
      if (allocations.error) throw allocations.error;

      return res.json({
        success: true,
        data: {
          projects_total: projects.count || 0,
          applications_total: applications.count || 0,
          allocations_total: allocations.count || 0
        }
      });
    }

    const { data: ownedProjects, error: ownedProjectsError } = await supabase
      .from('projects')
      .select('id')
      .eq('created_by', req.user.id);

    if (ownedProjectsError) throw ownedProjectsError;

    const projectIds = (ownedProjects || []).map((project) => project.id);

    if (!projectIds.length) {
      return res.json({
        success: true,
        data: {
          projects_total: 0,
          applications_total: 0,
          allocations_total: 0
        }
      });
    }

    const [projects, applications, allocations] = await Promise.all([
      supabase
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .in('id', projectIds),
      supabase
        .from('project_applications')
        .select('id', { count: 'exact', head: true })
        .in('project_id', projectIds),
      supabase
        .from('unit_allocations')
        .select('id', { count: 'exact', head: true })
        .in('project_id', projectIds)
    ]);

    if (projects.error) throw projects.error;
    if (applications.error) throw applications.error;
    if (allocations.error) throw allocations.error;

    res.json({
      success: true,
      data: {
        projects_total: projects.count || 0,
        applications_total: applications.count || 0,
        allocations_total: allocations.count || 0
      }
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getBrandProjects,
  getBrandAnalytics
};
