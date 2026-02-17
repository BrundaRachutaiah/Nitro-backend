const supabase = require('../config/supabaseClient');
const { logActivity } = require('../services/activityLog.service');

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

const hasValue = (value) => String(value || '').trim().length > 0;

const isPaymentDetailsComplete = (details) => {
  if (!details) return false;
  const required = [
    'address_line1',
    'city',
    'state',
    'pincode',
    'bank_account_number',
    'bank_ifsc'
  ];
  return required.every((field) => hasValue(details[field]));
};

const toIndiaDateKey = (value) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date(value));

/**
 * Apply to a project (Participant)
 */
const applyToProject = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { projectId } = req.params;
    const { productId, address = {}, bankDetails = {} } = req.body;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: 'productId is required'
      });
    }

    // Check project exists & is active
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, title, start_date, end_date, status')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Compare by India calendar day to avoid timezone edge cases around midnight.
    const todayKey = toIndiaDateKey(new Date());
    const startKey = toIndiaDateKey(project.start_date);
    const endKey = toIndiaDateKey(project.end_date);

    if (todayKey < startKey || todayKey > endKey) {
      return res.status(400).json({
        success: false,
        message: `Project is not active. Today (${todayKey}) must be between start date (${startKey}) and end date (${endKey}).`,
        data: {
          today: todayKey,
          startDate: startKey,
          endDate: endKey,
          projectStatus: String(project.status || '').toUpperCase()
        }
      });
    }

    const { data: product, error: productError } = await supabase
      .from('project_products')
      .select('id, project_id, name')
      .eq('id', productId)
      .eq('project_id', projectId)
      .maybeSingle();

    if (productError) throw productError;

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Selected product not found in this project'
      });
    }

    const accessCheck = await supabase
      .from('project_access_requests')
      .select('id, status')
      .eq('project_id', projectId)
      .eq('participant_id', participantId)
      .maybeSingle();

    if (!accessCheck.error) {
      if (!accessCheck.data || accessCheck.data.status !== 'APPROVED') {
        return res.status(403).json({
          success: false,
          message: 'Project access is not approved yet'
        });
      }
    } else if (!isMissingTableOrColumn(accessCheck.error)) {
      throw accessCheck.error;
    }

    // Prevent duplicate application
    const { data: existing } = await supabase
      .from('project_applications')
      .select('id')
      .eq('project_id', projectId)
      .eq('participant_id', participantId)
      .eq('product_id', productId)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Already applied to this product'
      });
    }

    const hasAddressInput = Object.values(address || {}).some(hasValue);
    const hasBankInput = Object.values(bankDetails || {}).some(hasValue);

    if (hasAddressInput || hasBankInput) {
      const requiredAddress = ['address_line1', 'city', 'state', 'pincode'];
      const missingAddress = requiredAddress.filter((field) => !hasValue(address?.[field]));
      const requiredBank = ['bank_account_number', 'bank_ifsc'];
      const missingBank = requiredBank.filter((field) => !hasValue(bankDetails?.[field]));

      if (missingAddress.length || missingBank.length) {
        return res.status(400).json({
          success: false,
          message: 'Address line 1, city, state, pincode, bank account number, and IFSC are required'
        });
      }

      const detailsPayload = {
        participant_id: participantId,
        address_line1: String(address.address_line1 || '').trim(),
        address_line2: hasValue(address.address_line2) ? String(address.address_line2).trim() : null,
        city: String(address.city || '').trim(),
        state: String(address.state || '').trim(),
        pincode: String(address.pincode || '').trim(),
        country: hasValue(address.country) ? String(address.country).trim() : 'India',
        bank_account_name: hasValue(bankDetails.bank_account_name) ? String(bankDetails.bank_account_name).trim() : null,
        bank_account_number: String(bankDetails.bank_account_number || '').trim(),
        bank_ifsc: String(bankDetails.bank_ifsc || '').trim().toUpperCase(),
        bank_name: hasValue(bankDetails.bank_name) ? String(bankDetails.bank_name).trim() : null,
        updated_at: new Date().toISOString()
      };

      const { error: detailUpsertError } = await supabase
        .from('participant_details')
        .upsert(detailsPayload, { onConflict: 'participant_id' });

      if (detailUpsertError) throw detailUpsertError;
    }

    // Create application
    const { data, error } = await supabase
      .from('project_applications')
      .insert({
        project_id: projectId,
        participant_id: participantId,
        product_id: productId,
        status: 'PENDING'
      })
      .select()
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
      action: 'PRODUCT_APPLICATION_SUBMITTED',
      entityType: 'PROJECT_APPLICATION',
      entityId: data.id,
      message: `${participantLabel} applied for ${product.name} in ${project.title || 'project'}`
    });

    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['ADMIN', 'SUPER_ADMIN'])
      .eq('status', 'APPROVED');

    if (admins?.length) {
      const notifications = admins.map((admin) => ({
        user_id: admin.id,
        type: 'PRODUCT_APPLICATION',
        title: 'New product application',
        message: `Participant applied for ${product.name} in ${project.title || 'a project'}`
      }));
      await supabase.from('notifications').insert(notifications);
    }

    res.status(201).json({
      success: true,
      message: 'Product application submitted for admin approval',
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
        project_id,
        product_id,
        allocated_budget,
        created_at,
        projects (
          id,
          name,
          title,
          mode
        ),
        project_products (
          id,
          name,
          product_url,
          product_value
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

const getPaymentDetails = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    const { data, error } = await supabase
      .from('participant_details')
      .select('*')
      .eq('participant_id', participantId)
      .maybeSingle();

    if (error) throw error;

    res.json({
      success: true,
      data: {
        hasPaymentDetails: isPaymentDetailsComplete(data),
        details: data || null
      }
    });
  } catch (err) {
    next(err);
  }
};

const savePaymentDetails = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { address = {}, bankDetails = {} } = req.body;

    const requiredAddress = ['address_line1', 'city', 'state', 'pincode'];
    const missingAddress = requiredAddress.filter((field) => !hasValue(address?.[field]));
    const requiredBank = ['bank_account_number', 'bank_ifsc'];
    const missingBank = requiredBank.filter((field) => !hasValue(bankDetails?.[field]));

    if (missingAddress.length || missingBank.length) {
      return res.status(400).json({
        success: false,
        message: 'Address line 1, city, state, pincode, bank account number, and IFSC are required'
      });
    }

    const detailsPayload = {
      participant_id: participantId,
      address_line1: String(address.address_line1 || '').trim(),
      address_line2: hasValue(address.address_line2) ? String(address.address_line2).trim() : null,
      city: String(address.city || '').trim(),
      state: String(address.state || '').trim(),
      pincode: String(address.pincode || '').trim(),
      country: hasValue(address.country) ? String(address.country).trim() : 'India',
      bank_account_name: hasValue(bankDetails.bank_account_name) ? String(bankDetails.bank_account_name).trim() : null,
      bank_account_number: String(bankDetails.bank_account_number || '').trim(),
      bank_ifsc: String(bankDetails.bank_ifsc || '').trim().toUpperCase(),
      bank_name: hasValue(bankDetails.bank_name) ? String(bankDetails.bank_name).trim() : null,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('participant_details')
      .upsert(detailsPayload, { onConflict: 'participant_id' })
      .select('*')
      .single();

    if (error) throw error;

    await logActivity({
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action: 'PAYMENT_DETAILS_UPDATED',
      entityType: 'PARTICIPANT_DETAILS',
      entityId: participantId,
      message: 'Participant updated payment details'
    });

    res.json({
      success: true,
      message: 'Payment details saved successfully',
      data: {
        hasPaymentDetails: isPaymentDetailsComplete(data),
        details: data
      }
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  applyToProject,
  getMyApplications,
  getPaymentDetails,
  savePaymentDetails
};
