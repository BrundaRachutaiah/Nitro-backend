const supabase = require('../config/supabaseClient');
const { logActivity } = require('../services/activityLog.service');
const { queueSuperAdminBatchDigestItem } = require('../services/superAdminBatchDigest.service');
const {
  ensureParticipantDetailsFromRegistration,
  persistParticipantDetails
} = require('../services/participantDetails.service');

const hasValue = (value) => String(value || '').trim().length > 0;

const isPaymentDetailsComplete = (details) => {
  if (!details) return false;
  const required = [
    'address_line1',
    'city',
    'state',
    'pincode',
    'bank_account_number',
    'bank_ifsc',
    'pan_number'
  ];
  return required.every((field) => hasValue(details[field]));
};

const isValidPAN = (pan) => /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(String(pan || '').trim().toUpperCase());

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

/**
 * Apply to a project (Participant)
 */
const applyToProject = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { projectId } = req.params;
    const { productId, quantity: rawQuantity, address = {}, bankDetails = {} } = req.body;

// Quantity must be a positive integer, default 1, max 10
const quantity = Math.min(10, Math.max(1, Math.floor(Number(rawQuantity) || 1)));

if (!productId) {
  return res.status(400).json({
    success: false,
    message: 'productId is required'
  });
}

    // Check project exists and is active
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, title, status')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    if (String(project.status || '').toLowerCase() !== 'published') {
      return res.status(400).json({
        success: false,
        message: 'Project is not currently active'
      });
    }

    // Check product exists in this project
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

    // Allow re-submission at any time — participant can always send a new request
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

      await persistParticipantDetails(participantId, detailsPayload);
    }
    let existingRes = await supabase
      .from('project_applications')
      .select('id, status, created_at')
      .eq('project_id', projectId)
      .eq('participant_id', participantId)
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingRes.error && /created_at/i.test(String(existingRes.error.message || ''))) {
      existingRes = await supabase
        .from('project_applications')
        .select('id, status')
        .eq('project_id', projectId)
        .eq('participant_id', participantId)
        .eq('product_id', productId)
        .limit(1)
        .maybeSingle();
    }

    if (existingRes.error && !isMissingSchemaObjectError(existingRes.error)) throw existingRes.error;

    const existing = existingRes.data || null;
    const existingStatus = String(existing?.status || '').toUpperCase();

    if (existing && existingStatus === 'PENDING') {
      return res.status(200).json({
        success: true,
        alreadyPending: true,
        message: 'You have already applied for this product. Please wait for admin approval.',
        data: existing
      });
    }

    const insertRes = await supabase
  .from('project_applications')
  .insert({
    project_id: projectId,
    participant_id: participantId,
    product_id: productId,
    quantity: quantity,
    status: 'PENDING'
  })
  .select()
  .single();

    if (insertRes.error) {
      if (insertRes.error.code === '23505') {
        return res.status(409).json({
          success: false,
          message: 'Repeat application is blocked by the current database constraint. Run the repeat-application SQL patch first.'
        });
      }
      throw insertRes.error;
    }

    const data = insertRes.data;

    // Queue a batched SUPER_ADMIN email (debounced for 30s)
    queueSuperAdminBatchDigestItem({ kind: 'REQUEST', id: data?.id });

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
      message: 'Your request has been submitted. We will check availability and inform you shortly.',
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
        .select(
          `
          id,
          project_id,
          product_id,
          allocation_id,
          allocated_budget,
          quantity,
          status,
          reviewed_at,
          created_at,
          projects (
            id,
            title,
            name,
            mode
          ),
          project_products (
            id,
            name,
            product_value,
            product_url
          )
        `
        )
        .eq('participant_id', participantId)
        .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED'])
        .order('created_at', { ascending: false })

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (err) {
    next(err);
  }
};

const markApplicationPurchased = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { id } = req.params;

    const { data, error } = await supabase
      .from('project_applications')
      .update({
        status: 'PURCHASED',
        reviewed_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('participant_id', participantId)
      .eq('status', 'APPROVED')
      .select('id, project_id, product_id, status')
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Application not found or not in approved state'
      });
    }

    res.json({
      success: true,
      message: 'Application moved to applied list',
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

    const details = await ensureParticipantDetailsFromRegistration(participantId, data || null);

    res.json({
      success: true,
      data: {
        hasPaymentDetails: isPaymentDetailsComplete(details),
        details: details || null
      }
    });
  } catch (err) {
    next(err);
  }
};

const savePaymentDetails = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { address = {}, bankDetails = {}, kycDetails = {} } = req.body;

    // Determine if address fields were actually provided (not just empty strings)
    const hasAddressData = hasValue(address?.address_line1) || hasValue(address?.city) ||
                           hasValue(address?.state) || hasValue(address?.pincode);

    const requiredBank = ['bank_account_number', 'bank_ifsc'];
    const missingBank = requiredBank.filter((field) => !hasValue(bankDetails?.[field]));

    // If address data is provided, validate it is complete
    if (hasAddressData) {
      const requiredAddress = ['address_line1', 'city', 'state', 'pincode'];
      const missingAddress = requiredAddress.filter((field) => !hasValue(address?.[field]));
      if (missingAddress.length) {
        return res.status(400).json({
          success: false,
          message: 'Address line 1, city, state, and pincode are all required when providing address details'
        });
      }
    }

    // Bank details are always required
    if (missingBank.length) {
      return res.status(400).json({
        success: false,
        message: 'Bank account number and IFSC code are required'
      });
    }

    // PAN is required
    if (!hasValue(kycDetails?.pan_number)) {
      return res.status(400).json({
        success: false,
        message: 'PAN card number is required'
      });
    }

    const panUpper = String(kycDetails.pan_number).trim().toUpperCase();
    if (!isValidPAN(panUpper)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid PAN format. Expected format: ABCDE1234F'
      });
    }

    // Build payload — only include address fields if they were provided
    const detailsPayload = {
      participant_id: participantId,
      bank_account_name: hasValue(bankDetails.bank_account_name) ? String(bankDetails.bank_account_name).trim() : null,
      bank_account_number: String(bankDetails.bank_account_number || '').trim(),
      bank_ifsc: String(bankDetails.bank_ifsc || '').trim().toUpperCase(),
      bank_name: hasValue(bankDetails.bank_name) ? String(bankDetails.bank_name).trim() : null,
      pan_number: panUpper,
      updated_at: new Date().toISOString()
    };

    if (hasAddressData) {
      detailsPayload.address_line1 = String(address.address_line1 || '').trim();
      detailsPayload.address_line2 = hasValue(address.address_line2) ? String(address.address_line2).trim() : null;
      detailsPayload.city    = String(address.city    || '').trim();
      detailsPayload.state   = String(address.state   || '').trim();
      detailsPayload.pincode = String(address.pincode || '').trim();
      detailsPayload.country = hasValue(address.country) ? String(address.country).trim() : 'India';
    }

    const data = await persistParticipantDetails(participantId, detailsPayload);

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
  markApplicationPurchased,
  getPaymentDetails,
  savePaymentDetails
};
