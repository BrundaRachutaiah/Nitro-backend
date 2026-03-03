const toAmount = (value) => {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
};

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

const getApprovedApplication = async ({ supabase, participantId, projectId }) => {
  let applicationRes = await supabase
    .from('project_applications')
    .select('id, product_id, allocated_budget')
    .eq('participant_id', participantId)
    .eq('project_id', projectId)
    .in('status', ['APPROVED', 'PURCHASED'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (applicationRes.error && /created_at/i.test(String(applicationRes.error.message || ''))) {
    applicationRes = await supabase
      .from('project_applications')
      .select('id, product_id, allocated_budget')
      .eq('participant_id', participantId)
      .eq('project_id', projectId)
      .in('status', ['APPROVED', 'PURCHASED'])
      .limit(1)
      .maybeSingle();
  }

  if (applicationRes.error) {
    if (isMissingSchemaObjectError(applicationRes.error)) return null;
    throw applicationRes.error;
  }
  return applicationRes.data || null;
};

const getProjectReward = async ({ supabase, projectId, fallbackReward = 0 }) => {
  const { data, error } = await supabase
    .from('projects')
    .select('reward')
    .eq('id', projectId)
    .maybeSingle();

  if (error) {
    if (isMissingSchemaObjectError(error)) return toAmount(fallbackReward);
    throw error;
  }
  return toAmount(data?.reward || fallbackReward);
};

const getProductAmount = async ({ supabase, application }) => {
  if (!application) return 0;

  // Always use product_value from project_products — never allocated_budget
  if (!application.product_id) return 0;

  const { data, error } = await supabase
    .from('project_products')
    .select('product_value')
    .eq('id', application.product_id)
    .maybeSingle();

  if (error) {
    if (isMissingSchemaObjectError(error)) return 0;
    throw error;
  }
  return toAmount(data?.product_value);
};

const calculatePayoutBreakdown = async ({
  supabase,
  participantId,
  projectId,
  fallbackReward = 0
}) => {
  const [rewardAmount, application] = await Promise.all([
    getProjectReward({ supabase, projectId, fallbackReward }),
    getApprovedApplication({ supabase, participantId, projectId })
  ]);

  const productAmount = await getProductAmount({ supabase, application });
  const totalAmount = rewardAmount + productAmount;

  return {
    rewardAmount,
    productAmount,
    totalAmount
  };
};

module.exports = {
  calculatePayoutBreakdown
};