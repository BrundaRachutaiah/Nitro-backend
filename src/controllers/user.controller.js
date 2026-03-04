const supabase = require('../config/supabaseClient');

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

/**
 * Get current user profile
 */
const getMyProfile = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // profiles table only has basic fields — bank/address live in participant_details
    const [profileRes, detailsRes] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, full_name, email, role, status, created_at')
        .eq('id', userId)
        .maybeSingle(),
      supabase
        .from('participant_details')
        .select('bank_account_number, bank_ifsc, bank_account_name, bank_name, address_line1, address_line2, city, state, pincode, country')
        .eq('participant_id', userId)
        .maybeSingle()
    ]);

    if (profileRes.error) throw profileRes.error;

    const profile = profileRes.data;
    if (!profile) {
      return res.status(404).json({
        success: false,
        message: 'Profile not found'
      });
    }

    // Merge: bank/address come entirely from participant_details
    const details = detailsRes.data || {};
    const merged = {
      ...profile,
      bank_account_number: details.bank_account_number || null,
      bank_ifsc:           details.bank_ifsc           || null,
      bank_account_name:   details.bank_account_name   || null,
      bank_name:           details.bank_name           || null,
      address_line1:       details.address_line1       || null,
      address_line2:       details.address_line2       || null,
      city:                details.city                || null,
      state:               details.state               || null,
      pincode:             details.pincode             || null,
      country:             details.country             || 'India',
    };

    res.json({ success: true, data: merged });
  } catch (err) {
    next(err);
  }
};

/**
 * Update current user profile
 */
const updateMyProfile = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { full_name, email } = req.body;

    const normalizedFullName = String(full_name || '').trim();

    if (!normalizedFullName) {
      return res.status(400).json({
        success: false,
        message: 'full_name is required'
      });
    }

    const updates = { full_name: normalizedFullName };

    if (email !== undefined) {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (!normalizedEmail) {
        return res.status(400).json({
          success: false,
          message: 'email cannot be empty'
        });
      }

      if (!isValidEmail(normalizedEmail)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }

      const { data: emailOwner, error: emailLookupError } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', normalizedEmail)
        .neq('id', userId)
        .maybeSingle();

      if (emailLookupError) throw emailLookupError;
      if (emailOwner) {
        return res.status(409).json({
          success: false,
          message: 'Email is already in use'
        });
      }

      updates.email = normalizedEmail;
    }

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Profile updated',
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Notification settings
 */
const getMyNotificationSettings = async (req, res, next) => {
  try {
    const userId = req.user.id;

    let { data, error } = await supabase
      .from('user_notification_settings')
      .select(
        'email_enabled, push_enabled, project_updates, payout_updates'
      )
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      const { data: created, error: insertError } = await supabase
        .from('user_notification_settings')
        .insert({ user_id: userId })
        .select(
          'email_enabled, push_enabled, project_updates, payout_updates'
        )
        .single();

      if (insertError) throw insertError;
      data = created;
    }

    res.json({
      success: true,
      data
    });
  } catch (err) {
    next(err);
  }
};

const updateMyNotificationSettings = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const allowedFields = [
      'email_enabled',
      'push_enabled',
      'project_updates',
      'payout_updates'
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields provided'
      });
    }

    const { data, error } = await supabase
      .from('user_notification_settings')
      .upsert({
        user_id: userId,
        ...updates
      })
      .select(
        'email_enabled, push_enabled, project_updates, payout_updates'
      )
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Notification settings updated',
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Purchase proofs
 */
const getMyPurchaseProofs = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    const { data, error } = await supabase
      .from('purchase_proofs')
      .select(
        `
        id,
        status,
        created_at,
        projects (
          id,
          title,
          reward
        )
      `
      )
      .eq('participant_id', participantId)
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
 * Profile completion
 */
const getProfileCompletion = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('full_name, email, status')
      .eq('id', userId)
      .single();

    if (error) throw error;

    const checks = {
      full_name: Boolean(profile.full_name),
      email: Boolean(profile.email),
      approved: profile.status === 'APPROVED'
    };

    const total = Object.keys(checks).length;
    const completed = Object.values(checks).filter(Boolean).length;

    const percentage = Math.round((completed / total) * 100);

    const missing = Object.keys(checks).filter(
      key => !checks[key]
    );

    res.json({
      success: true,
      data: {
        percentage,
        completed,
        total,
        missing,
        is_complete: percentage === 100
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Notifications
 */
const getMyNotifications = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('notifications')
      .select('id, type, title, message, is_read, created_at')
      .eq('user_id', userId)
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

const markNotificationRead = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { data, error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.json({
      success: true,
      message: 'Notification marked as read'
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Support tickets
 */
const createSupportTicket = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { subject, message } = req.body;

    if (!subject || !message) {
      return res.status(400).json({
        success: false,
        message: 'Subject and message are required'
      });
    }

    const { data, error } = await supabase
      .from('support_tickets')
      .insert({
        user_id: userId,
        subject,
        message
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Support ticket created',
      data
    });
  } catch (err) {
    next(err);
  }
};

const getMySupportTickets = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('support_tickets')
      .select('id, subject, status, created_at')
      .eq('user_id', userId)
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

module.exports = {
  getMyProfile,
  updateMyProfile,
  getMyNotificationSettings,
  updateMyNotificationSettings,
  getMyPurchaseProofs,
  getProfileCompletion,
  getMyNotifications,
  markNotificationRead,
  createSupportTicket,
  getMySupportTickets
};