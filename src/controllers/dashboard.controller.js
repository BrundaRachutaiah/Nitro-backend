const supabase = require('../config/supabaseClient');
const { buildDateRange } = require('../utils/date.utils');

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
    const now = new Date();
    const requestedRange = buildDateRange(req.query);
    const range = requestedRange || {
      from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      to: now
    };

    if (Number.isNaN(range.from.getTime()) || Number.isNaN(range.to.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date range'
      });
    }

    let from = range.from;
    let to = range.to;
    if (from > to) {
      const temp = from;
      from = to;
      to = temp;
    }

    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    // Some environments store purchase proof time as uploaded_at, others as created_at.
    let reviewsRes = await supabase
      .from('purchase_proofs')
      .select('created_at')
      .gte('created_at', fromIso)
      .lte('created_at', toIso);

    let proofDateField = 'created_at';
    if (reviewsRes.error) {
      reviewsRes = await supabase
        .from('purchase_proofs')
        .select('uploaded_at')
        .gte('uploaded_at', fromIso)
        .lte('uploaded_at', toIso);
      proofDateField = 'uploaded_at';
    }

    if (reviewsRes.error) throw reviewsRes.error;

    let samplesRes = await supabase
      .from('project_applications')
      .select('created_at')
      .gte('created_at', fromIso)
      .lte('created_at', toIso);

    let appDateField = 'created_at';
    if (samplesRes.error) {
      samplesRes = await supabase
        .from('project_applications')
        .select('applied_at')
        .gte('applied_at', fromIso)
        .lte('applied_at', toIso);
      appDateField = 'applied_at';
    }

    if (samplesRes.error) throw samplesRes.error;

    const totalDays = Math.max(
      1,
      Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24))
    );
    const bucketCount = 4;
    const bucketSizeDays = Math.max(1, Math.ceil(totalDays / bucketCount));

    const formatBucketDate = (date) => {
      const d = new Date(date);
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    };

    const weeks = [0, 1, 2, 3].map((index) => ({
      label: (() => {
        const start = new Date(from);
        start.setDate(start.getDate() + index * bucketSizeDays);
        const end = new Date(start);
        end.setDate(end.getDate() + bucketSizeDays - 1);
        if (end > to) end.setTime(to.getTime());
        return `${formatBucketDate(start)} - ${formatBucketDate(end)}`;
      })(),
      reviews: 0,
      samples: 0
    }));

    const addToBucket = (dateString, key) => {
      const diffDays = Math.max(
        0,
        Math.floor((new Date(dateString).getTime() - from.getTime()) / (1000 * 60 * 60 * 24))
      );
      const bucket = Math.min(bucketCount - 1, Math.floor(diffDays / bucketSizeDays));
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
