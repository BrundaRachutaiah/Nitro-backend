const supabase = require('../config/supabaseClient');

const getSummary = async (req, res, next) => {
  try {
    const [participants, projects, proofs, payouts] = await Promise.all([
      supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'PARTICIPANT'),
      supabase
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'published'),
      supabase
        .from('purchase_proofs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'PENDING'),
      supabase
        .from('payout_batches')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'PENDING')
    ]);

    res.json({
      success: true,
      data: {
        participants_total: participants.count || 0,
        projects_active: projects.count || 0,
        purchase_proofs_pending: proofs.count || 0,
        payouts_pending: payouts.count || 0
      }
    });
  } catch (err) {
    next(err);
  }
};

const getActivity = async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 10;

    const { data, error } = await supabase
      .from('activity_logs')
      .select('id, action, entity_type, message, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({ success: true, data: data || [] });
  } catch (err) {
    next(err);
  }
};

const getProjectPerformance = async (req, res, next) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 28);

    // Some environments store purchase proof time as uploaded_at, others as created_at.
    let reviewsRes = await supabase
      .from('purchase_proofs')
      .select('created_at')
      .gte('created_at', since.toISOString());

    let proofDateField = 'created_at';
    if (reviewsRes.error) {
      reviewsRes = await supabase
        .from('purchase_proofs')
        .select('uploaded_at')
        .gte('uploaded_at', since.toISOString());
      proofDateField = 'uploaded_at';
    }

    if (reviewsRes.error) throw reviewsRes.error;

    let samplesRes = await supabase
      .from('project_applications')
      .select('created_at')
      .gte('created_at', since.toISOString());

    let appDateField = 'created_at';
    if (samplesRes.error) {
      samplesRes = await supabase
        .from('project_applications')
        .select('applied_at')
        .gte('applied_at', since.toISOString());
      appDateField = 'applied_at';
    }

    if (samplesRes.error) throw samplesRes.error;

    const weeks = [0, 1, 2, 3].map((index) => ({
      label: `Week ${index + 1}`,
      reviews: 0,
      samples: 0
    }));

    const addToBucket = (dateString, key) => {
      const diffDays = Math.max(
        0,
        Math.floor((new Date(dateString).getTime() - since.getTime()) / (1000 * 60 * 60 * 24))
      );
      const bucket = Math.min(3, Math.floor(diffDays / 7));
      weeks[bucket][key] += 1;
    };

    for (const row of reviewsRes.data || []) addToBucket(row[proofDateField], 'reviews');
    for (const row of samplesRes.data || []) addToBucket(row[appDateField], 'samples');

    res.json({
      success: true,
      data: weeks.map((item) => ({
        label: item.label,
        value: item.reviews,
        reviews: item.reviews,
        samples: item.samples
      }))
    });
  } catch (err) {
    next(err);
  }
};

const exportData = async (req, res) => {
  res.json({ success: true, message: 'Export started' });
};

module.exports = {
  getSummary,
  getActivity,
  getProjectPerformance,
  exportData
};
