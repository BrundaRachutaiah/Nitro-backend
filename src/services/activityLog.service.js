const supabase = require('../config/supabaseClient');

const logActivity = async ({
  actorId = null,
  actorRole = 'SYSTEM',
  action = 'SYSTEM_EVENT',
  entityType = 'SYSTEM',
  entityId = null,
  message = null
} = {}) => {
  try {
    await supabase.from('activity_logs').insert({
      actor_id: actorId,
      actor_role: String(actorRole || 'SYSTEM'),
      action: String(action || 'SYSTEM_EVENT'),
      entity_type: String(entityType || 'SYSTEM'),
      entity_id: entityId,
      message
    });
  } catch (err) {
    // Do not block primary workflow if activity logging fails.
    // eslint-disable-next-line no-console
    console.warn('Activity log insert failed:', err?.message || err);
  }
};

module.exports = {
  logActivity
};
