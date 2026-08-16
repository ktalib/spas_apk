/**
 * Client-side mirror of the server's validation rules.
 *
 * WHY THIS MATTERS MORE OFFLINE THAN ONLINE
 * A record that fails validation online shows an error immediately and the
 * surveyor fixes it on the spot. A record queued offline that fails validation
 * sits in the outbox failing on every push attempt — and by the time anyone
 * notices, the surveyor has left the site and can no longer supply the answer.
 *
 * So an invalid record must be REFUSED at capture time, never queued and hoped
 * for. That is the whole reason this file exists.
 *
 * The authority is app/Services/SpaMobileService.php in the Laravel repo, whose
 * rules are shared by the desktop form, the mobile web form and the API. If
 * those change, this changes. See API_CONTRACT.md §4.
 */

const MAX = 255;

function req(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * @returns {Object<string,string>} field => message. Empty means valid.
 */
export function validateLandRecord(data) {
  const errors = {};

  if (!req(data.land_title_type) || !['statutory', 'customary'].includes(data.land_title_type)) {
    errors.land_title_type = 'Choose statutory or customary.';
  }

  const isCustomary = data.land_title_type === 'customary';

  // Customary numbers are generated server-side, so the client never sends one.
  if (!isCustomary && !req(data.file_number)) {
    errors.file_number = 'Pick the indexed file for this record.';
  }

  if (!req(data.owner_name)) {
    errors.owner_name = 'Owner / file title is required.';
  } else if (String(data.owner_name).length > MAX) {
    errors.owner_name = 'Owner name is too long.';
  }

  if (!req(data.proposed_use)) errors.proposed_use = 'Approved land use is required.';
  if (!req(data.existing_use)) errors.existing_use = 'Prevailing land use is required.';

  // The rule that broke every customary mobile save in Aug 2026 when the form
  // lacked the field. A customary title has no indexed file to inherit an
  // address from, so the LGA is the minimum needed to place it.
  if (isCustomary && !req(data.lga)) {
    errors.lga = 'Select the LGA for this customary title.';
  }

  if (req(data.phone) && String(data.phone).length > 20) {
    errors.phone = 'Phone number is too long.';
  }

  return errors;
}

export function validateFieldData(data) {
  const errors = {};

  if (!req(data.inspection_date)) {
    errors.inspection_date = 'Inspection date is required.';
  }

  if (!req(data.findings)) {
    errors.findings = 'Findings are required.';
  }

  // Coordinates are OPTIONAL by product decision (Q5): a surveyor may have no
  // GPS fix, and losing the record entirely is worse than losing the pin. The
  // UI warns instead — see warnFieldData().
  if (req(data.coordinates) && !parseCoordinates(data.coordinates)) {
    errors.coordinates = 'Coordinates could not be read — re-pick the pin.';
  }

  return errors;
}

/** Non-blocking advice. The surveyor may save anyway. */
export function warnFieldData(data) {
  const warnings = [];

  if (!req(data.coordinates)) {
    warnings.push('No location pin. You are on the plot now — tap GPS if you can, or the office will have to place it later.');
  }

  return warnings;
}

/**
 * Accepts the map picker's JSON, an object, or a raw "lat, lng" string.
 * Mirrors SpaMobileService::normalizeCoordinates().
 *
 * @returns {{lat:number,lng:number}|null}
 */
export function parseCoordinates(raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  let decoded = raw;

  if (typeof raw === 'string') {
    try {
      decoded = JSON.parse(raw);
    } catch {
      decoded = null;
    }
  }

  if (decoded && typeof decoded === 'object'
      && Number.isFinite(Number(decoded.lat)) && Number.isFinite(Number(decoded.lng))) {
    return { lat: Number(decoded.lat), lng: Number(decoded.lng) };
  }

  if (typeof raw === 'string') {
    const matches = raw.match(/-?\d+(?:\.\d+)?/g);
    if (matches && matches.length >= 2) {
      return { lat: Number(matches[0]), lng: Number(matches[1]) };
    }
  }

  return null;
}

export function hasErrors(errors) {
  return Object.keys(errors).length > 0;
}

export function firstError(errors) {
  const keys = Object.keys(errors);
  return keys.length ? errors[keys[0]] : null;
}
