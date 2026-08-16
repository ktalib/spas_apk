/**
 * Derive a land use from the file number when the indexed record has none.
 *
 * KLAES file numbers encode their land use in the prefix, so a file with a null
 * `land_use_type` is not actually unknown — the answer is in its own number.
 * Showing "—" there is a missing display, not missing data, and it matters in
 * the field: the surveyor uses the approved use to judge a contravention, so a
 * blank forces a guess.
 *
 * Mapping is the canonical one from .agent/skills/klaes/SKILL.md.
 *
 * ORDER MATTERS. Longest prefix first, or "CON-AG-RC-1990-36" matches the
 * shorter "CON-AG" and the recertification variants are never reached.
 */

const PREFIX_MAP = [
  // CON + recertification (longest)
  ['CON-RES-RC', 'Residential'],
  ['CON-COM-RC', 'Commercial'],
  ['CON-IND-RC', 'Industrial'],
  ['CON-AG-RC',  'Agriculture'],

  // Recertification
  ['RES-RC', 'Residential'],
  ['COM-RC', 'Commercial'],
  ['IND-RC', 'Industrial'],
  ['AG-RC',  'Agriculture'],

  // Conversion
  ['CON-RES', 'Residential'],
  ['CON-COM', 'Commercial'],
  ['CON-IND', 'Industrial'],
  ['CON-AG',  'Agriculture'],

  // Direct
  ['RES', 'Residential'],
  ['COM', 'Commercial'],
  ['IND', 'Industrial'],
  ['AG',  'Agriculture']
];

/**
 * @param {string} fileNumber e.g. "CON-AG-1990-36", "RES-2005-1259"
 * @returns {string|null} canonical land use, or null when the prefix is unknown
 */
export function landUseFromFileNumber(fileNumber) {
  if (!fileNumber) return null;

  const value = String(fileNumber).toUpperCase().trim();

  for (const [prefix, use] of PREFIX_MAP) {
    // Anchored, and the prefix must end at a separator so "AG" cannot match
    // "AGRIC-…" or some unrelated number that merely starts with those letters.
    if (value === prefix || value.startsWith(prefix + '-') || value.startsWith(prefix + '/')) {
      return use;
    }
  }

  return null;
}

/** Stored value if present, otherwise inferred from the file number. */
export function resolveLandUse(row) {
  const stored = row?.land_use_type;

  if (stored && String(stored).trim() !== '' && String(stored).trim() !== '-') {
    return stored;
  }

  return landUseFromFileNumber(row?.file_number);
}

/**
 * Best available name for a file.
 *
 * The index carries the holder under different columns depending on where the
 * row came from, and any of them can be blank — which is why some cards showed
 * a bare dash. Try each before giving up.
 */
export function resolveOwner(row) {
  const candidates = [row?.owner_name, row?.file_title, row?.current_holder, row?.holder_name];

  for (const value of candidates) {
    if (value && String(value).trim() !== '' && String(value).trim() !== '-') {
      return String(value).trim();
    }
  }

  return null;
}
