const supabase = require('../config/supabaseClient');

const hasValue = (value) => String(value || '').trim().length > 0;

const pickString = (value, fallback = null) => {
  if (!hasValue(value)) return fallback;
  return String(value).trim();
};

const isConflictTargetError = (error) => {
  const text = String(error?.message || '').toLowerCase();
  return (
    text.includes('conflict')
    || text.includes('constraint')
    || text.includes('no unique')
    || text.includes('there is no unique')
    || text.includes('on conflict')
  );
};

const persistParticipantDetails = async (participantId, payload) => {
  const normalizedPayload = {
    participant_id: participantId,
    ...payload,
    updated_at: new Date().toISOString()
  };

  const upsertRes = await supabase
    .from('participant_details')
    .upsert(normalizedPayload, { onConflict: 'participant_id' })
    .select('*')
    .single();

  if (!upsertRes.error) {
    return upsertRes.data;
  }

  if (!isConflictTargetError(upsertRes.error)) {
    throw upsertRes.error;
  }

  const existingRes = await supabase
    .from('participant_details')
    .select('*')
    .eq('participant_id', participantId)
    .maybeSingle();

  if (existingRes.error) throw existingRes.error;

  if (existingRes.data) {
    const updateRes = await supabase
      .from('participant_details')
      .update(normalizedPayload)
      .eq('participant_id', participantId)
      .select('*')
      .single();

    if (updateRes.error) throw updateRes.error;
    return updateRes.data;
  }

  const insertRes = await supabase
    .from('participant_details')
    .insert(normalizedPayload)
    .select('*')
    .single();

  if (insertRes.error) throw insertRes.error;
  return insertRes.data;
};

const buildRegistrationDetailsPayload = (participantId, authUser, existingDetails = null) => {
  const registration = authUser?.user_metadata?.registration_details || {};
  const address = registration?.address || {};
  const bank = registration?.bank_details || {};
  const kyc = registration?.kyc || {};

  const candidate = {
    participant_id: participantId,
    address_line1: pickString(address.address_line1),
    address_line2: pickString(address.address_line2),
    city: pickString(address.city),
    state: pickString(address.state),
    pincode: pickString(address.pincode),
    country: pickString(address.country, 'India'),
    bank_account_name: pickString(bank.account_holder_name),
    bank_account_number: pickString(bank.account_number),
    bank_ifsc: pickString(bank.ifsc_code)?.toUpperCase() || null,
    pan_number: pickString(kyc.pan_number)?.toUpperCase() || null
  };

  if (existingDetails) {
    return {
      participant_id: participantId,
      address_line1: hasValue(existingDetails.address_line1) ? existingDetails.address_line1 : candidate.address_line1,
      address_line2: hasValue(existingDetails.address_line2) ? existingDetails.address_line2 : candidate.address_line2,
      city: hasValue(existingDetails.city) ? existingDetails.city : candidate.city,
      state: hasValue(existingDetails.state) ? existingDetails.state : candidate.state,
      pincode: hasValue(existingDetails.pincode) ? existingDetails.pincode : candidate.pincode,
      country: hasValue(existingDetails.country) ? existingDetails.country : candidate.country,
      bank_account_name: hasValue(existingDetails.bank_account_name) ? existingDetails.bank_account_name : candidate.bank_account_name,
      bank_account_number: hasValue(existingDetails.bank_account_number) ? existingDetails.bank_account_number : candidate.bank_account_number,
      bank_ifsc: hasValue(existingDetails.bank_ifsc) ? existingDetails.bank_ifsc : candidate.bank_ifsc,
      bank_name: hasValue(existingDetails.bank_name) ? existingDetails.bank_name : null,
      pan_number: hasValue(existingDetails.pan_number) ? existingDetails.pan_number : candidate.pan_number
    };
  }

  return candidate;
};

const ensureParticipantDetailsFromRegistration = async (participantId, existingDetails = null) => {
  const { data: authData, error: authError } = await supabase.auth.admin.getUserById(participantId);
  if (authError) throw authError;

  const authUser = authData?.user || null;
  const payload = buildRegistrationDetailsPayload(participantId, authUser, existingDetails);

  const hasAnyData = [
    payload.address_line1,
    payload.city,
    payload.state,
    payload.pincode,
    payload.bank_account_name,
    payload.bank_account_number,
    payload.bank_ifsc,
    payload.pan_number
  ].some(hasValue);

  if (!hasAnyData) {
    return existingDetails || null;
  }

  const shouldPersist = !existingDetails || [
    'address_line1',
    'city',
    'state',
    'pincode',
    'country',
    'bank_account_name',
    'bank_account_number',
    'bank_ifsc',
    'pan_number'
  ].some((field) => !hasValue(existingDetails?.[field]) && hasValue(payload?.[field]));

  if (!shouldPersist) {
    return existingDetails;
  }

  const persistedPayload = { ...payload };

  if (existingDetails?.bank_name && !persistedPayload.bank_name) {
    persistedPayload.bank_name = existingDetails.bank_name;
  }

  return persistParticipantDetails(participantId, persistedPayload);
};

module.exports = {
  ensureParticipantDetailsFromRegistration,
  persistParticipantDetails
};
