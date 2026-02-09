const supabase = require('../config/supabaseClient');

/**
 * Apply to a project (Participant)
 */
const applyToProject = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { projectId } = req.params;

    // Check project exists & is active
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, start_date, end_date')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    const today = new Date();
    if (
      today < new Date(project.start_date) ||
      today > new Date(project.end_date)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Project is not active'
      });
    }

    // Prevent duplicate application
    const { data: existing } = await supabase
      .from('project_applications')
      .select('id')
      .eq('project_id', projectId)
      .eq('participant_id', participantId)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Already applied to this project'
      });
    }

    // Create application
    const { data, error } = await supabase
      .from('project_applications')
      .insert({
        project_id: projectId,
        participant_id: participantId
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Applied successfully',
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get my applications
 */
const getMyApplications = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    const { data, error } = await supabase
      .from('project_applications')
      .select(`
        id,
        status,
        created_at,
        projects (
          id,
          name,
          mode
        )
      `)
      .eq('participant_id', participantId);

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  applyToProject,
  getMyApplications
};
