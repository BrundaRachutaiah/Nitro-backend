const supabase = require('../config/supabaseClient');

/**
 * GLOBAL SEARCH
 * Accessible to all logged-in users
 * Searches only published projects
 */
const globalSearch = async (req, res, next) => {
  try {
    const q = req.query.q?.trim();

    if (!q) {
      return res.json({
        success: true,
        data: {
          projects: []
        }
      });
    }

    const searchTerm = `%${q}%`;

    const { data, error } = await supabase
      .from('projects')
      .select('id, title, description, reward')
      .eq('status', 'published')
      .ilike('title', searchTerm)
      .limit(20);

    if (error) throw error;

    res.json({
      success: true,
      data: {
        projects: data || []
      }
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  globalSearch
};
