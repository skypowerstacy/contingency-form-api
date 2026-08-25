/*
 * Environment variables — all set in the Railway service, none have defaults:
 *
 *   HUBSPOT_PRIVATE_APP_TOKEN  HubSpot private app token. Every CRM read/write.
 *   RESEND_API_KEY             Transactional email to ops.
 *   SUPABASE_URL               Supabase project URL (file storage, report rows).
 *   SUPABASE_SERVICE_ROLE_KEY  Supabase service-role key.
 *   ANTHROPIC_API_KEY          Backs POST /report, the damage-report generator.
 *   ADMIN_TOKEN                Shared secret for GET /admin-deals, sent by
 *                              public/admin-dashboard.html as the x-admin-token
 *                              header. MUST BE SET IN RAILWAY before the admin
 *                              dashboard will load — until it is, /admin-deals
 *                              refuses every request with 401 rather than
 *                              falling open.
 *   PORT                       Supplied by Railway.
 */
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { Resend } = require('resend');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const archiver = require('archiver');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

const resend = new Resend(process.env.RESEND_API_KEY);

// ---- Inspection endpoint constants ----------------------------------------
const HUBSPOT_API = 'https://api.hubapi.com';
const INSPECTION_PIPELINE = '2476304118';
const INSPECTION_STAGE = '4130205409'; // Site Inspection
const SUPABASE_PROJECT_REF = 'rfytaiowxtpmesqzoidz';
const PHOTO_BUCKET = 'inspections';
const PHOTO_ZIP_NAME = 'inspection-photos.zip';
/*
 * Folder the generated report PDF lives in, under {dealId}/ in PHOTO_BUCKET.
 * Written by POST /generate-pdf, which is the only producer of it — the report
 * is no longer built in the browser and no longer arrives on /inspection.
 * /inspection still excludes this category from the gallery, so a stray file
 * filed here by an older client never shows up as an inspection photo.
 */
const REPORT_PDF_CATEGORY = 'report';
const CONTINGENCY_BUCKET = 'contingency';
const CONTINGENCY_ZIP_NAME = 'contingency-form.zip';
const SCOPE_BUCKET = 'scopes';
const SCOPE_ZIP_NAME = 'scope.zip';
// Both stages live in Roofing - Insurance, the pipeline INSPECTION_PIPELINE names.
const CONTINGENCY_SIGNED_STAGE = '4109489900';
// Public report page the shareable link points at.
const REPORT_PAGE_URL = 'https://nuhome-deals-dashboard.vercel.app/inspection-report.html';
const SCOPE_REVIEW_STAGE = '4109489903';

// ---- Retail submission endpoint constants ----------------------------------
const RETAIL_PIPELINE = '2477633213'; // Roofing - Retail
const RETAIL_STAGE = '4106670802';    // Intake
/*
 * Each documents section is zipped and stored on its own, so a rep can replace
 * the estimate without touching the measurement report. folder is the path
 * under {dealId}/ in PHOTO_BUCKET; property is where the zip URL lands on the
 * deal.
 */
const RETAIL_SECTIONS = [
  {
    field: 'measurement_report',
    folder: 'measurement-report',
    zipName: 'measurement-report.zip',
    label: 'Measurement report',
    property: 'measurement_report_url',
  },
  {
    field: 'signed_estimate',
    folder: 'signed-estimate',
    zipName: 'signed-estimate.zip',
    label: 'Signed estimate',
    property: 'signed_estimate_url',
  },
  {
    field: 'site_photos',
    folder: 'site-photos',
    zipName: 'site-photos.zip',
    label: 'Site photos',
    property: 'retail_photos_url',
  },
];

/*
 * Ops/Install. Sales deals live here and the Deals Dashboard reads from it —
 * nothing in this service may ever write to it. This is the same guard the
 * RepCard sync carries, for the same reason.
 */
const FORBIDDEN_PIPELINE = '1022523097';

/*
 * Every pipeline this service is allowed to write to. Adding one here is the
 * only way to widen the guard — FORBIDDEN_PIPELINE is checked first and
 * separately, so it stays refused even if it were ever added by mistake.
 */
const ALLOWED_PIPELINES = new Set([INSPECTION_PIPELINE, RETAIL_PIPELINE]);

/**
 * Throws unless the target pipeline is one this service may write to. Called
 * before every deal write rather than once at boot, so a future code path
 * cannot route around it by constructing its own payload.
 */
function assertPipelineAllowed(pipelineId) {
  const id = String(pipelineId);
  if (id === FORBIDDEN_PIPELINE) {
    throw new Error(
      `Refusing to write to pipeline ${FORBIDDEN_PIPELINE} (Ops/Install). This service only writes to ${[...ALLOWED_PIPELINES].join(', ')}.`
    );
  }
  if (!ALLOWED_PIPELINES.has(id)) {
    throw new Error(`Unexpected pipeline ${id}. This service only writes to ${[...ALLOWED_PIPELINES].join(', ')}.`);
  }
}

/*
 * Total-upload cap, checked per route after parsing — multer has no option for
 * a combined limit.
 */
const MAX_TOTAL_UPLOAD_BYTES = 200 * 1024 * 1024;

/*
 * Per-file cap, applied by each upload route after parsing rather than by
 * multer: an oversized file skips itself and the rest of the submission goes
 * through, instead of the whole request failing on one bad photo.
 */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/heic',
      'image/heif',
      'image/heif-sequence',
      'image/heic-sequence',
      'application/pdf',
    ];

    /*
     * Browsers disagree on HEIC in particular — the same photo off an iPhone can
     * arrive as image/heic, application/octet-stream, or an empty mimetype
     * depending on the browser. Falling back to the extension means a rep does
     * not lose a legitimate roof photo to a header we cannot control.
     */
    const allowedExtension = /\.(jpe?g|png|heic|pdf)$/i;

    // Strip any parameters, e.g. "image/jpeg; charset=utf-8".
    const mimetype = (file.mimetype || '').split(';')[0].trim();

    if (allowed.includes(mimetype) || allowedExtension.test(file.originalname || '')) {
      cb(null, true);
    } else {
      // Not a MulterError, so the global handler cannot infer this is the
      // caller's fault — tag it explicitly or it reports as a 500.
      const err = new Error('Only JPG, PNG, HEIC, and PDF files are accepted.');
      err.status = 400;
      cb(err);
    }
  }
});

app.use(cors({ origin: '*' }));
app.use(express.json());

/**
 * Escapes a value for interpolation into the notification email's HTML.
 *
 * The submission form is public, so every field here is attacker-controllable
 * text rather than trusted input — without this, a name containing markup
 * renders as live HTML in the recipient's inbox. The & replacement must run
 * first, otherwise it would double-escape the entities added after it.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Address handling (shared by /submit's storage path and deal lookup) ----

/*
 * Full USPS street-suffix set plus directionals. Applied token by token to the
 * lowercased, punctuation-stripped address, so "123 N Main St" and
 * "123 north main street" collapse to the same string.
 *
 * Identity entries (park, loop, way…) are kept deliberately: the map doubles as
 * the canonical list, and a no-op lookup costs nothing.
 */
const ABBREVS = {
  'n': 'north', 'ne': 'northeast', 'nw': 'northwest',
  's': 'south', 'se': 'southeast', 'sw': 'southwest',
  'e': 'east', 'w': 'west',
  'aly': 'alley', 'anx': 'annex', 'arc': 'arcade', 'ave': 'avenue',
  'byu': 'bayou', 'bch': 'beach', 'bnd': 'bend', 'blf': 'bluff',
  'blfs': 'bluffs', 'btm': 'bottom', 'blvd': 'boulevard', 'br': 'branch',
  'brg': 'bridge', 'brk': 'brook', 'brks': 'brooks', 'bg': 'burg',
  'bgs': 'burgs', 'byp': 'bypass', 'cp': 'camp', 'cyn': 'canyon',
  'cpe': 'cape', 'cswy': 'causeway', 'ctr': 'center', 'ctrs': 'centers',
  'cir': 'circle', 'cirs': 'circles', 'clf': 'cliff', 'clfs': 'cliffs',
  'clb': 'club', 'cmn': 'common', 'cmns': 'commons', 'cor': 'corner',
  'cors': 'corners', 'crse': 'course', 'ct': 'court', 'cts': 'courts',
  'cv': 'cove', 'cvs': 'coves', 'crk': 'creek', 'cres': 'crescent',
  'crst': 'crest', 'xing': 'crossing', 'xrd': 'crossroad',
  'xrds': 'crossroads', 'curv': 'curve', 'dl': 'dale', 'dm': 'dam',
  'dv': 'divide', 'dr': 'drive', 'drs': 'drives', 'est': 'estate',
  'ests': 'estates', 'expy': 'expressway', 'ext': 'extension',
  'exts': 'extensions', 'fall': 'fall', 'fls': 'falls', 'fry': 'ferry',
  'fld': 'field', 'flds': 'fields', 'flt': 'flat', 'flts': 'flats',
  'frd': 'ford', 'frds': 'fords', 'frst': 'forest', 'frg': 'forge',
  'frgs': 'forges', 'frk': 'fork', 'frks': 'forks', 'ft': 'fort',
  'fwy': 'freeway', 'gdn': 'garden', 'gdns': 'gardens', 'gtwy': 'gateway',
  'gln': 'glen', 'glns': 'glens', 'grn': 'green', 'grns': 'greens',
  'grv': 'grove', 'grvs': 'groves', 'hbr': 'harbor', 'hbrs': 'harbors',
  'hvn': 'haven', 'hts': 'heights', 'hwy': 'highway', 'hl': 'hill',
  'hls': 'hills', 'holw': 'hollow', 'inlt': 'inlet', 'is': 'island',
  'iss': 'islands', 'isle': 'isle', 'jct': 'junction', 'jcts': 'junctions',
  'ky': 'key', 'kys': 'keys', 'knl': 'knoll', 'knls': 'knolls',
  'lk': 'lake', 'lks': 'lakes', 'land': 'land', 'lndg': 'landing',
  'ln': 'lane', 'lgt': 'light', 'lgts': 'lights', 'lf': 'loaf',
  'lck': 'lock', 'lcks': 'locks', 'ldg': 'lodge', 'loop': 'loop',
  'mall': 'mall', 'mnr': 'manor', 'mnrs': 'manors', 'mdw': 'meadow',
  'mdws': 'meadows', 'mews': 'mews', 'ml': 'mill', 'mls': 'mills',
  'msn': 'mission', 'mtwy': 'motorway', 'mt': 'mount', 'mtn': 'mountain',
  'mtns': 'mountains', 'nck': 'neck', 'orch': 'orchard', 'oval': 'oval',
  'opas': 'overpass', 'park': 'park', 'pkwy': 'parkway', 'pass': 'pass',
  'psge': 'passage', 'path': 'path', 'pike': 'pike', 'pne': 'pine',
  'pnes': 'pines', 'pl': 'place', 'pln': 'plain', 'plns': 'plains',
  'plz': 'plaza', 'pt': 'point', 'pts': 'points', 'prt': 'port',
  'prts': 'ports', 'pr': 'prairie', 'radl': 'radial', 'ramp': 'ramp',
  'rnch': 'ranch', 'rpds': 'rapids', 'rst': 'rest', 'rdg': 'ridge',
  'rdgs': 'ridges', 'riv': 'river', 'rd': 'road', 'rds': 'roads',
  'rte': 'route', 'row': 'row', 'rue': 'rue', 'run': 'run',
  'shl': 'shoal', 'shls': 'shoals', 'shr': 'shore', 'shrs': 'shores',
  'skwy': 'skyway', 'spg': 'spring', 'spgs': 'springs', 'spur': 'spur',
  'sq': 'square', 'sqs': 'squares', 'sta': 'station', 'stra': 'stravenue',
  'strm': 'stream', 'st': 'street', 'sts': 'streets', 'smt': 'summit',
  'ter': 'terrace', 'trwy': 'throughway', 'trce': 'trace', 'trak': 'track',
  'trfy': 'trafficway', 'trl': 'trail', 'tunl': 'tunnel', 'tpke': 'turnpike',
  'upas': 'underpass', 'un': 'union', 'uns': 'unions', 'vly': 'valley',
  'vlys': 'valleys', 'via': 'viaduct', 'vw': 'view', 'vws': 'views',
  'vill': 'village', 'vlg': 'village', 'vlgs': 'villages', 'vis': 'vista',
  'walk': 'walk', 'wall': 'wall', 'way': 'way', 'ways': 'ways',
  'wl': 'well', 'wls': 'wells',
};

/**
 * Canonical form for comparison only: lowercased, punctuation stripped, common
 * street abbreviations expanded, whitespace collapsed. "123 Main St." and
 * "123 main street" both become "123 main street".
 */
function normaliseAddress(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => ABBREVS[word] || word)
    .join(' ');
}

/** Storage-path-safe folder name. Slashes would silently create sub-folders. */
function addressSlug(value) {
  const slug = String(value || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w.-]/g, '');
  return slug || 'unknown-address';
}

/*
 * Deal matching is scored rather than boolean: address alone matched the wrong
 * deal on duplexes and repeat customers at one address, so the homeowner name
 * is weighed alongside it.
 */
const ADDRESS_WEIGHT = 0.6;
const NAME_WEIGHT = 0.4;
const MATCH_THRESHOLD = 0.5;
// No name submitted is not evidence against a candidate, so it scores neutral
// rather than zero — otherwise a nameless submission would need a near-perfect
// address just to clear the threshold.
const NEUTRAL_NAME_SCORE = 0.5;

/** Lowercased word tokens. normaliseName() strips spaces, so it cannot tokenize. */
function nameTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Fraction of the submitted address's tokens present in the candidate's.
 * Directional: extra tokens on the HubSpot side (unit numbers, city) cost
 * nothing, which is what tolerates partial addresses on file.
 */
function scoreAddress(submittedNorm, candidateNorm) {
  const submitted = String(submittedNorm || '').split(' ').filter(Boolean);
  if (!submitted.length) return 0;
  const present = new Set(String(candidateNorm || '').split(' ').filter(Boolean));
  return submitted.filter(token => present.has(token)).length / submitted.length;
}

/** Fraction of the submitted name's tokens present in the contact's full name. */
function scoreName(submittedName, contactProperties) {
  const submitted = nameTokens(submittedName);
  if (!submitted.length) return NEUTRAL_NAME_SCORE;
  const present = new Set(
    nameTokens(`${contactProperties?.firstname || ''} ${contactProperties?.lastname || ''}`)
  );
  return submitted.filter(token => present.has(token)).length / submitted.length;
}

/*
 * The scope form defaults a blank name to a placeholder for display; reading
 * req.body directly keeps that placeholder out of the scoring.
 */
function submittedHomeownerName(body) {
  return (body?.homeownerName ?? body?.customerName ?? '').toString().trim();
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

/**
 * Uploads each file individually, then a zip of all of them, into
 * {bucket}/{slug}/. Returns the public URL of the zip.
 *
 * The folder is the property address rather than the deal id: the deal lookup
 * needs the zip URL to write onto the deal, so the id is not known yet.
 */
async function uploadFilesAndZip({ bucket, slug, files, zipName, label, defaultExt = 'pdf' }) {
  const supabase = createSupabaseClient();
  const uploaded = [];
  const failed = [];

  console.log(`${label} uploading`, files.length, 'file(s) to', `${bucket}/${slug}/`);

  for (const file of files) {
    const safeName = String(file.originalname || `page.${defaultExt}`).replace(/[^\w.\-]/g, '_');
    const path = `${slug}/${safeName}`;
    const { error } = await supabase.storage.from(bucket).upload(path, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
    });
    if (error) failed.push(`${path}: ${error.message}`);
    else uploaded.push(path);
  }

  // A zip failure must not discard the files that already uploaded.
  let zipUrl = null;
  try {
    const zipBuffer = await zipEntries(files.map((file, i) => ({
      name: file.originalname || `page-${i + 1}.${defaultExt}`,
      buffer: file.buffer,
    })));
    const zipPath = `${slug}/${zipName}`;
    const { error } = await supabase.storage.from(bucket).upload(zipPath, zipBuffer, {
      contentType: 'application/zip',
      upsert: true,
    });
    if (error) failed.push(`${zipPath}: ${error.message}`);
    else zipUrl = `https://${SUPABASE_PROJECT_REF}.supabase.co/storage/v1/object/public/${bucket}/${zipPath}`;
  } catch (err) {
    failed.push(`${slug}/${zipName}: ${err.message}`);
  }

  console.log(`${label} storage done. uploaded:`, uploaded.length, 'failed:', failed.length, 'zipUrl:', zipUrl);
  return { uploaded, failed, zipUrl };
}

/**
 * Finds the Roofing - Insurance deal for a property by matching the address on
 * the associated contact.
 *
 * HubSpot search cannot express "roughly this address", so it is narrowed
 * server-side on the street number (the most selective token) and the fuzzy
 * comparison happens here.
 */
async function findDealByAddress(rawAddress, rawName, pipelineId = INSPECTION_PIPELINE) {
  const target = normaliseAddress(rawAddress);
  if (!target) return null;

  const token = (target.match(/\d+/) || [])[0] || target.split(' ')[0];
  if (!token) return null;

  const search = await hubspot('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'address', operator: 'CONTAINS_TOKEN', value: token }] }],
      properties: ['address', 'firstname', 'lastname', 'email'],
      limit: 100,
    }),
  });

  const round = n => Number(n.toFixed(2));

  const scored = (search?.results || []).map(contact => {
    const address = scoreAddress(target, normaliseAddress(contact.properties?.address));
    const name = scoreName(rawName, contact.properties);
    const combined = (address * ADDRESS_WEIGHT) + (name * NAME_WEIGHT);
    console.log('[deal-lookup] candidate scores:',
      { address: round(address), name: round(name), combined: round(combined) },
      '- contact:', contact.id, JSON.stringify(contact.properties?.address || ''));
    return { contact, combined };
  });

  // Highest first, so the best match is tried before any weaker one.
  const candidates = scored
    .filter(c => c.combined >= MATCH_THRESHOLD)
    .sort((a, b) => b.combined - a.combined);

  console.log('[deal-lookup] address:', JSON.stringify(target), '- token:', token,
    '- name:', JSON.stringify(rawName || ''),
    '- contacts searched:', scored.length, '- above threshold:', candidates.length);

  for (const { contact } of candidates) {
    const assoc = await hubspot(`/crm/v4/objects/contacts/${contact.id}/associations/deals`);
    for (const row of assoc?.results || []) {
      const dealId = String(row.toObjectId);
      const deal = await hubspot(`/crm/v3/objects/deals/${dealId}?properties=pipeline,dealstage,dealname`);
      const pipeline = String(deal?.properties?.pipeline || '');
      if (pipeline === String(pipelineId)) {
        return { dealId, pipeline, contactId: contact.id, dealname: deal?.properties?.dealname };
      }
    }
  }
  return null;
}

async function updateContingencyDeal(deal, fields, zipUrl) {
  // Asserted against the pipeline HubSpot actually reports for this deal, not
  // against our own constant — so a deal in the forbidden pipeline can never be
  // patched even if the lookup above were ever loosened.
  assertPipelineAllowed(deal.pipeline);

  const properties = { dealstage: CONTINGENCY_SIGNED_STAGE };
  if (fields.claimNumber) properties.claim_number = fields.claimNumber;
  if (fields.adjusterName) properties.adjuster_name = fields.adjusterName;
  if (fields.adjusterPhone) properties.adjuster_phone = fields.adjusterPhone;
  if (fields.adjusterEmail) properties.adjuster_email = fields.adjusterEmail;
  /*
   * The form's date input already sends YYYY-MM-DD, which is the shape a
   * HubSpot date property wants — no conversion. The companion time field has
   * nowhere to go on a date property, so it reaches ops via the email only.
   */
  const meetingDate = (fields.adjusterAppointmentDate || '').toString().trim();
  if (meetingDate) properties.adjuster_meeting_date = meetingDate;
  if (zipUrl) properties.contingency_form_url = zipUrl;

  await hubspot(`/crm/v3/objects/deals/${deal.dealId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  });

  console.log('[submit] deal', deal.dealId, 'moved to Contingency Signed with', Object.keys(properties).join(', '));
}

/*
 * The contingency form collects one free-text name, so the split is positional:
 * first word is the first name, everything after it is the last name. That gets
 * "Mary Anne Van Der Berg" wrong in the ways you would expect, but it beats
 * dropping the surname, and ops can correct it in HubSpot.
 */
function splitCustomerName(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  return { fname: parts[0] || '', lname: parts.slice(1).join(' ') };
}

/**
 * Creates the contact and deal when no existing deal matched the address.
 *
 * The contingency form has no email or phone, so the contact cannot be deduped
 * — upsertContact always creates in that case. A rep who submits the same
 * address twice without a deal existing yet therefore gets two contacts; the
 * address lookup catches it from the second submission onward.
 */
async function createContingencyDeal(fields, zipUrl) {
  assertPipelineAllowed(INSPECTION_PIPELINE);

  const { fname, lname } = splitCustomerName(fields.customerName);
  const contactId = await upsertContact({ fname, lname, address: fields.propertyAddress });

  const properties = {
    dealname: String(fields.customerName || '').trim() || 'Unknown homeowner',
    pipeline: INSPECTION_PIPELINE,
    dealstage: CONTINGENCY_SIGNED_STAGE,
  };
  if (fields.propertyAddress) properties.customers_full_address = fields.propertyAddress;
  if (fields.insuranceCarrier) properties.insurance_company = fields.insuranceCarrier;
  if (fields.claimNumber) properties.claim_number = fields.claimNumber;
  if (fields.adjusterName) properties.adjuster_name = fields.adjusterName;
  if (fields.adjusterPhone) properties.adjuster_phone = fields.adjusterPhone;
  if (fields.adjusterEmail) properties.adjuster_email = fields.adjusterEmail;
  // Already YYYY-MM-DD off the form's date input — same as updateContingencyDeal.
  const meetingDate = (fields.adjusterAppointmentDate || '').toString().trim();
  if (meetingDate) properties.adjuster_meeting_date = meetingDate;
  if (zipUrl) properties.contingency_form_url = zipUrl;

  let closerWarning = null;
  try {
    const closer = await resolveCloserOption(fields.repName);
    if (closer) properties.closer = closer;
    else if (fields.repName) closerWarning = `No "closer" option matched rep "${fields.repName}" — property omitted.`;
  } catch (err) {
    closerWarning = `Could not resolve "closer" options: ${err.message}`;
  }

  const deal = await hubspot('/crm/v3/objects/deals', {
    method: 'POST',
    body: JSON.stringify({ properties }),
  });

  if (contactId) {
    await hubspot(
      `/crm/v4/objects/deals/${deal.id}/associations/default/contacts/${contactId}`,
      { method: 'PUT' }
    );
  }

  console.log('[submit] created deal', deal.id, 'and contact', contactId, 'with', Object.keys(properties).join(', '));
  return { dealId: deal.id, contactId, closerWarning };
}

app.post('/submit', upload.array('files', 10), async (req, res) => {
  /*
   * Drop files over the per-file cap and keep going. multer no longer enforces
   * this, so an oversized file arrives fully buffered and is discarded here.
   */
  const oversized = (req.files || []).filter(f => f.size > MAX_FILE_BYTES);
  const acceptedFiles = (req.files || []).filter(f => f.size <= MAX_FILE_BYTES);
  req.files = acceptedFiles;
  if (oversized.length) {
    console.warn('Skipped oversized files:', oversized.map(f => `${f.originalname} (${(f.size / 1024 / 1024).toFixed(1)}MB)`));
  }

  // Total cap applies to what survived the filter, not what was sent.
  const totalBytes = acceptedFiles.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
    return res.status(400).json({
      success: false,
      error: 'FILE_TOO_LARGE',
      message: 'Total upload size exceeds 200MB. Please remove some photos and try again.',
    });
  }

  try {
    const {
      repName,
      customerName,
      propertyAddress,
      insuranceCarrier,
      claimNumber,
      adjusterName,
      adjusterPhone,
      adjusterEmail,
      adjusterAppointmentDate,
      adjusterAppointmentTime,
      submittedAt,
    } = req.body;
    const files = req.files;

    // Distinguishes "you attached nothing" from "everything you attached was
    // dropped by the 25MB filter" — otherwise the rep is told to attach a file
    // they can see they already attached.
    if (oversized.length && (!files || files.length === 0)) {
      return res.status(400).json({
        error: 'All attached files exceeded the 25MB size limit. Please compress and resubmit.',
      });
    }

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'At least one file is required.' });
    }

    /*
     * Matches what the frontend actually enforces. Carrier, claim number and
     * adjuster details are frequently unknown when the contingency is signed —
     * they arrive later — so they flow through to HubSpot and the email when
     * present and are simply omitted when not.
     */
    const required = [
      [repName, 'Rep name'],
      [customerName, 'Customer name'],
      [propertyAddress, 'Property address'],
    ];

    for (const [value, label] of required) {
      if (!value || value.trim() === '') {
        return res.status(400).json({ error: `${label} is required.` });
      }
    }

    /*
     * Storage and HubSpot are both best-effort: the email to ops is the part
     * that must not be lost, so every failure below is collected as a warning
     * and the request still succeeds.
     */
    const warnings = [];
    const slug = addressSlug(propertyAddress);

    let zipUrl = null;
    try {
      const result = await uploadFilesAndZip({
        bucket: CONTINGENCY_BUCKET,
        slug,
        files,
        zipName: CONTINGENCY_ZIP_NAME,
        label: '[submit]',
      });
      zipUrl = result.zipUrl;
      if (result.failed.length) {
        console.error('[submit] storage failures:', result.failed);
        warnings.push(`${result.failed.length} file(s) failed to upload to storage`);
      }
    } catch (err) {
      console.error('[submit] Supabase upload failed:', err);
      warnings.push('Files were not uploaded to storage');
    }

    try {
      const deal = await findDealByAddress(propertyAddress, submittedHomeownerName(req.body));
      if (deal) {
        await updateContingencyDeal(deal, req.body, zipUrl);
      } else {
        console.warn('[submit] no Roofing - Insurance deal found for address:', propertyAddress, '— creating one');
        const created = await createContingencyDeal(req.body, zipUrl);
        if (created.closerWarning) {
          console.warn('[submit]', created.closerWarning);
          warnings.push(created.closerWarning);
        }
      }
    } catch (err) {
      console.error('[submit] HubSpot deal update/create failed:', err);
      warnings.push('HubSpot deal was not created or updated');
    }

    // Deliberately NOT escapeHtml'd: this is an attachment filename, not an
    // HTML context, so escaping would turn a legitimate "R&D report.pdf" into
    // "R&amp;D report.pdf" on the saved file. No filename reaches the email
    // HTML today — if one ever does, escape it at that interpolation site.
    const attachments = files.map((file, i) => ({
      filename: file.originalname || `contingency-form-page-${i + 1}.${file.mimetype.split('/')[1]}`,
      content: file.buffer.toString('base64'),
    }));

    const submittedDate = submittedAt
      ? new Date(submittedAt).toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'full', timeStyle: 'short' })
      : new Date().toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'full', timeStyle: 'short' });

    // These are optional now, so they may be empty or absent entirely — a bare
    // .trim() on an absent field would throw before the email is ever sent.
    const optional = value => (value || '').trim() || 'Not provided';

    /*
     * The datetime-local input sends a wall-clock value with no offset, e.g.
     * "2026-08-20T14:30" — the rep means 2:30 PM Denver. Node would parse that
     * in the server's own zone (UTC on Railway), so formatting it in
     * America/Denver would shift it back six hours and print 8:30 AM.
     *
     * Pinning the value to UTC and formatting in UTC therefore prints exactly
     * the wall clock the rep typed, which is the Denver time they meant. Same
     * reasoning as the date-only field this replaces: a wall-clock value has
     * to be rendered verbatim, not converted. submittedDate above is different
     * — it is a real instant, so it genuinely converts to Denver.
     */
    const appointmentDate = (adjusterAppointmentDate || '').trim();
    const appointmentTime = (adjusterAppointmentTime || '').trim();

    // Pinned to UTC and formatted in UTC so the date prints exactly as typed.
    const parsedDate = appointmentDate ? new Date(`${appointmentDate}T12:00:00Z`) : null;
    const adjusterAppointmentDateDisplay = !appointmentDate
      ? 'Not scheduled'
      : parsedDate && !isNaN(parsedDate.getTime())
        ? parsedDate.toLocaleDateString('en-US', {
            timeZone: 'UTC',
            dateStyle: 'full',
          })
        : appointmentDate;

    // "14:30" -> "2:30 PM". Same wall-clock reasoning: never converted.
    const parsedTime = appointmentTime ? new Date(`1970-01-01T${appointmentTime}Z`) : null;
    const adjusterAppointmentTimeDisplay = !appointmentTime
      ? 'Not provided'
      : parsedTime && !isNaN(parsedTime.getTime())
        ? parsedTime.toLocaleTimeString('en-US', {
            timeZone: 'UTC',
            hour: 'numeric',
            minute: '2-digit',
          })
        : appointmentTime;

    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a1a2e; padding: 24px; border-radius: 8px 8px 0 0;">
          <h1 style="color: #f97316; margin: 0; font-size: 20px;">NuHome — Contingency Form Submission</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-radius: 0 0 8px 8px;">
          <p style="margin: 0 0 12px;"><strong>Customer:</strong> ${escapeHtml(customerName.trim())}</p>
          <p style="margin: 0 0 12px;"><strong>Property Address:</strong> ${escapeHtml(propertyAddress.trim())}</p>
          <p style="margin: 0 0 12px;"><strong>Insurance Carrier:</strong> ${escapeHtml(optional(insuranceCarrier))}</p>
          <p style="margin: 0 0 12px;"><strong>Claim Number:</strong> ${escapeHtml(optional(claimNumber))}</p>
          <p style="margin: 0 0 12px;"><strong>Adjuster Name:</strong> ${escapeHtml(optional(adjusterName))}</p>
          <p style="margin: 0 0 12px;"><strong>Adjuster Phone:</strong> ${escapeHtml(optional(adjusterPhone))}</p>
          <p style="margin: 0 0 12px;"><strong>Adjuster Email:</strong> ${escapeHtml(optional(adjusterEmail))}</p>
          <p style="margin: 0 0 12px;"><strong>Adjuster Appointment Date:</strong> ${escapeHtml(adjusterAppointmentDateDisplay)}</p>
          <p style="margin: 0 0 12px;"><strong>Adjuster Appointment Time:</strong> ${escapeHtml(adjusterAppointmentTimeDisplay)}</p>
          <p style="margin: 0 0 12px;"><strong>Rep:</strong> ${escapeHtml(repName.trim())}</p>
          <p style="margin: 0 0 12px;"><strong>Submitted:</strong> ${escapeHtml(submittedDate)}</p>
          <p style="margin: 0 0 12px;"><strong>Pages attached:</strong> ${files.length}</p>
          <p style="margin: 24px 0 0; color: #6b7280; font-size: 13px;">
            ${files.length} file${files.length > 1 ? 's' : ''} attached to this email.
          </p>
        </div>
      </div>
    `;

    await resend.emails.send({
      from: 'NuHome Forms <noreply@thehiveoffice.com>',
      to: ['misty@thenuhome.com', 'mariah@thenuhome.com'],
      subject: `Contingency Form — ${customerName.trim()} — ${new Date().toLocaleDateString('en-US', { timeZone: 'America/Denver' })}`,
      html: emailHtml,
      attachments,
    });

    res.json({ success: true, ...(warnings.length ? { warnings } : {}) });

  } catch (err) {
    console.error('Submission error:', err);
    res.status(500).json({ error: err.message || 'Submission failed. Please try again.' });
  }
});

// ===========================================================================
// /inspection — site inspection intake from public/inspection.html
// ===========================================================================

async function hubspot(path, options = {}) {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) throw new Error('HUBSPOT_PRIVATE_APP_TOKEN is not set.');

  const res = await fetch(`${HUBSPOT_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (!res.ok) {
    const detail = body?.message || text || res.statusText;
    throw new Error(`HubSpot ${options.method || 'GET'} ${path} failed (${res.status}): ${detail}`);
  }
  return body;
}

/** Creates the contact, or patches the existing one when the email is taken. */
async function upsertContact({ fname, lname, customer_email, phone, address }) {
  const properties = {};
  if (fname) properties.firstname = fname;
  if (lname) properties.lastname = lname;
  if (customer_email) properties.email = customer_email;
  if (phone) properties.phone = phone;
  if (address) properties.address = address;

  // Without an email there is nothing to dedupe on, so always create.
  if (!customer_email) {
    const created = await hubspot('/crm/v3/objects/contacts', {
      method: 'POST',
      body: JSON.stringify({ properties }),
    });
    return created.id;
  }

  const search = await hubspot('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: customer_email }] }],
      properties: ['email'],
      limit: 1,
    }),
  });

  const existing = search?.results?.[0];
  if (existing) {
    await hubspot(`/crm/v3/objects/contacts/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });
    return existing.id;
  }

  const created = await hubspot('/crm/v3/objects/contacts', {
    method: 'POST',
    body: JSON.stringify({ properties }),
  });
  return created.id;
}

function normaliseName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * `closer` is an enumeration, so an unrecognised string is rejected outright by
 * HubSpot and would fail the whole deal write. Resolve the rep name against the
 * live option list and drop the property when nothing matches.
 */
async function resolveDealEnumOption(propertyName, personName) {
  if (!personName) return null;
  const property = await hubspot(`/crm/v3/properties/deals/${propertyName}`);
  const options = property?.options || [];
  const target = normaliseName(personName);
  if (!target) return null;

  const exact = options.find(o => normaliseName(o.label) === target || normaliseName(o.value) === target);
  if (exact) return exact.value;

  const partial = options.find(o => {
    const label = normaliseName(o.label);
    return label && (label.includes(target) || target.includes(label));
  });
  return partial ? partial.value : null;
}

async function resolveCloserOption(repName) {
  return resolveDealEnumOption('closer', repName);
}

async function resolveSetterOption(setterName) {
  return resolveDealEnumOption('setter', setterName);
}

async function createInspectionDeal(fields, contactId) {
  assertPipelineAllowed(INSPECTION_PIPELINE);

  const { fname, lname, carrier, stormDate, squares, rep } = fields;
  const dealname = [fname, lname].filter(Boolean).join(' ') || 'Unknown homeowner';

  const properties = {
    dealname,
    pipeline: INSPECTION_PIPELINE,
    dealstage: INSPECTION_STAGE,
  };
  if (fields.address) properties.customers_full_address = fields.address;
  if (fields.phone) properties.customer_cell_phone = fields.phone;
  if (fields.customer_email) properties.customer_email = fields.customer_email;
  if (carrier) properties.insurance_company = carrier;
  // The form collects one storm date; HubSpot has no storm_date property, so it
  // lands on date_of_loss alone.
  if (stormDate) properties.date_of_loss = stormDate;
  if (squares) properties.number_of_squares = squares;

  let closerWarning = null;
  try {
    const closer = await resolveCloserOption(rep);
    if (closer) properties.closer = closer;
    else if (rep) closerWarning = `No "closer" option matched rep "${rep}" — property omitted.`;
  } catch (err) {
    closerWarning = `Could not resolve "closer" options: ${err.message}`;
  }

  /*
   * Same shape as closer: setter is an enumeration, so an unrecognised string
   * would be rejected by HubSpot and fail the whole deal write. Resolve against
   * the live option list and drop the property when nothing matches.
   */
  let setterWarning = null;
  try {
    const setter = await resolveSetterOption(fields.setter);
    if (setter) properties.setter = setter;
    else if (fields.setter) setterWarning = `No "setter" option matched "${fields.setter}" — property omitted.`;
  } catch (err) {
    setterWarning = `Could not resolve "setter" options: ${err.message}`;
  }

  const deal = await hubspot('/crm/v3/objects/deals', {
    method: 'POST',
    body: JSON.stringify({ properties }),
  });

  if (contactId) {
    await hubspot(
      `/crm/v4/objects/deals/${deal.id}/associations/default/contacts/${contactId}`,
      { method: 'PUT' }
    );
  }

  return { dealId: deal.id, closerWarning, setterWarning };
}

/*
 * supabase-js constructs a RealtimeClient even when only storage is used, and
 * on Node < 22 there is no global WebSocket — createClient throws outright.
 * Supplying `ws` keeps it working regardless of the Node the platform picks.
 *
 * Built per call rather than at module scope on purpose: at module scope it
 * would throw at boot whenever the Supabase env vars are unset, taking the
 * whole service down instead of degrading to "files were not uploaded".
 */
function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.');

  return createClient(url, key, {
    global: { fetch: fetch },
    realtime: { transport: ws },
  });
}

/**
 * Buffers [{ name, buffer }] entries into a single in-memory zip.
 *
 * Compression is level 1 on purpose: JPEG, HEIC and PDF are already compressed,
 * so a higher level burns CPU on a container for a negligible size win.
 */
function zipEntries(entries) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 1 } });
    const chunks = [];

    archive.on('data', chunk => chunks.push(chunk));
    archive.on('warning', err => reject(err));
    archive.on('error', err => reject(err));
    archive.on('end', () => resolve(Buffer.concat(chunks)));

    for (const entry of entries) archive.append(entry.buffer, { name: entry.name });
    archive.finalize();
  });
}

/** Inspection photos are grouped into {category}/{originalname} inside the zip. */
function zipPhotos(photos) {
  return zipEntries(photos.map(p => ({
    name: `${p.category}/${p.originalname || 'photo.jpg'}`,
    buffer: p.buffer,
  })));
}

async function uploadPhotos(dealId, photos) {
  const supabase = createSupabaseClient();
  console.log('Starting photo upload, file count:', photos.length);

  const uploaded = [];
  const failed = [];

  for (const photo of photos) {
    console.log('Uploading photo:', photo.fieldname, photo.originalname, photo.buffer?.length, 'bytes');
    const safeName = String(photo.originalname || 'photo.jpg').replace(/[^\w.\-]/g, '_');
    const path = `${dealId}/${photo.category}/${safeName}`;
    const { data, error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, photo.buffer, {
      contentType: photo.mimetype,
      upsert: true,
    });
    console.log('Supabase upload result for', path, '- data:', data, '- error:', error);
    if (error) failed.push(`${path}: ${error.message}`);
    /*
     * safeName has already stripped everything outside [\w.-], and dealId and
     * category are machine-generated, so the path needs no URL encoding.
     */
    else uploaded.push({
      path,
      category: photo.category,
      url: `https://${SUPABASE_PROJECT_REF}.supabase.co/storage/v1/object/public/${PHOTO_BUCKET}/${path}`,
    });
  }

  // Zip failures must not discard the individual uploads that already
  // succeeded, so this is caught separately from the loop above.
  let photosUrl = null;
  try {
    const zipBuffer = await zipPhotos(photos);
    console.log('Zip built:', zipBuffer.length, 'bytes from', photos.length, 'photos');

    const zipPath = `${dealId}/${PHOTO_ZIP_NAME}`;
    const { data, error } = await supabase.storage.from(PHOTO_BUCKET).upload(zipPath, zipBuffer, {
      contentType: 'application/zip',
      upsert: true,
    });
    console.log('Supabase zip upload result for', zipPath, '- data:', data, '- error:', error);

    if (error) failed.push(`${zipPath}: ${error.message}`);
    else photosUrl = `https://${SUPABASE_PROJECT_REF}.supabase.co/storage/v1/object/public/${PHOTO_BUCKET}/${zipPath}`;
  } catch (err) {
    console.error('Zip creation failed:', err);
    failed.push(`${dealId}/${PHOTO_ZIP_NAME}: ${err.message}`);
  }

  console.log('Photo upload complete, URL:', photosUrl);

  return { uploaded, failed, photosUrl };
}

// ---- Inspection report records ---------------------------------------------
const REPORTS_TABLE = 'nuhome_inspection_reports';

/*
 * PostgREST rather than supabase-js: the client here is constructed for storage
 * only, and the service role key bypasses RLS, so a plain fetch is the whole
 * dependency. Trailing slashes on SUPABASE_URL would produce a double slash.
 */
function supabaseRest(path) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.');
  return {
    endpoint: `${url}/rest/v1/${path}`,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  };
}

/** Inserts the report row and returns its generated uuid. */
async function saveInspectionReport({ dealId, fields, damageReport, reportJson, photosUrl, photoUrls }) {
  const { endpoint, headers } = supabaseRest(REPORTS_TABLE);

  const res = await fetch(endpoint, {
    method: 'POST',
    // Without return=representation PostgREST answers 201 with an empty body,
    // and the generated id — the whole point of the insert — is lost.
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({
      deal_id: dealId,
      report_data: { fields, damageReport, reportJson, photoUrls: photoUrls || [] },
      photos_url: photosUrl,
    }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message || `Supabase returned HTTP ${res.status}`);

  const row = Array.isArray(body) ? body[0] : body;
  if (!row?.id) throw new Error('Supabase insert returned no id.');
  return row.id;
}

function inspectionEmailHtml(fields, damageReport, photosUrl, photoCount, notes) {
  const rows = [
    ['Property address', fields.address],
    ['Homeowner', [fields.fname, fields.lname].filter(Boolean).join(' ')],
    ['Phone', fields.phone],
    ['Email', fields.customer_email],
    ['Insurance carrier', fields.carrier],
    ['Closer', fields.rep],
    ['Setter', fields.setter],
    ['Inspection Performed By', fields.inspector],
    ['Storm date', fields.stormDate],
    ['Hail size', fields.hailSize],
    ['Roof pitch', fields.pitch],
    ['Stories', fields.stories],
    ['Roof size (squares)', fields.squares],
    ['Roof age', fields.roofAge],
    ['Severity', fields.severity],
    ['Mortgage', fields.mortgage],
    ['Recommendation', fields.recommendation],
    ['Inspector notes', fields.notes],
    ['Inspection date', fields.inspectionDate],
  ]
    .map(([label, value]) => `
      <tr>
        <td style="padding:6px 12px 6px 0;color:#6b7280;font-size:13px;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>
        <td style="padding:6px 0;color:#111827;font-size:13px">${escapeHtml(value || '—')}</td>
      </tr>`)
    .join('');

  const noteBlock = notes.length
    ? `<p style="margin:16px 0 0;color:#b45309;font-size:12px">Partial submission — ${escapeHtml(notes.join(' · '))}</p>`
    : '';

  const photoBlock = photosUrl
    ? `<p style="margin:16px 0 0;font-size:13px"><a href="${escapeHtml(photosUrl)}" style="color:#C9922A">View ${photoCount} inspection photo${photoCount === 1 ? '' : 's'} →</a></p>`
    : `<p style="margin:16px 0 0;color:#6b7280;font-size:13px">${photoCount} photo${photoCount === 1 ? '' : 's'} received — storage link unavailable.</p>`;

  return `
    <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto;">
      <div style="background:#1B2A4A;padding:24px;border-radius:8px 8px 0 0">
        <h1 style="color:#C9922A;margin:0;font-size:20px">NuHome — Site Inspection Submitted</h1>
      </div>
      <div style="background:#f9fafb;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px">
        <table style="width:100%;border-collapse:collapse">${rows}</table>
        ${photoBlock}
        <h2 style="font-size:14px;margin:24px 0 8px;color:#111827">Damage report</h2>
        <pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;color:#374151;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:0">${escapeHtml(damageReport || 'No report generated.')}</pre>
        ${noteBlock}
      </div>
    </div>
  `;
}

app.post('/inspection', upload.any(), async (req, res) => {
  /*
   * Drop files over the per-file cap and keep going. multer no longer enforces
   * this, so an oversized file arrives fully buffered and is discarded here.
   */
  const oversized = (req.files || []).filter(f => f.size > MAX_FILE_BYTES);
  const acceptedFiles = (req.files || []).filter(f => f.size <= MAX_FILE_BYTES);
  req.files = acceptedFiles;
  if (oversized.length) {
    console.warn('Skipped oversized files:', oversized.map(f => `${f.originalname} (${(f.size / 1024 / 1024).toFixed(1)}MB)`));
  }

  // Total cap applies to what survived the filter, not what was sent.
  const totalBytes = acceptedFiles.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
    return res.status(400).json({
      success: false,
      error: 'FILE_TOO_LARGE',
      message: 'Total upload size exceeds 200MB. Please remove some photos and try again.',
    });
  }

  const notes = [];
  if (oversized.length) notes.push(`${oversized.length} photo(s) over 25MB were skipped — ask rep to compress before resubmitting`);
  let dealId = null;
  let photosUrl = null;
  let reportId = null;
  let reportUrl = null;
  let photoUrls = [];

  console.log('[inspection] files received:', (req.files || []).map(f => ({ fieldname: f.fieldname, originalname: f.originalname, size: f.buffer?.length })));

  const FIELDS = [
    'address', 'fname', 'lname', 'phone', 'customer_email', 'carrier', 'rep',
    'setter', 'inspector',
    'stormDate', 'hailSize', 'pitch', 'stories', 'squares', 'roofAge',
    'severity', 'mortgage', 'recommendation', 'notes', 'inspectionDate',
  ];

  try {
    const fields = {};
    for (const key of FIELDS) fields[key] = (req.body?.[key] ?? '').toString().trim();
    const damageReport = (req.body?.damageReport ?? '').toString();

    /*
     * The structured AI report, sent alongside the flattened damageReport text.
     * The shareable report page renders from this — badge, findings and their
     * severities survive here but not in the flattened text. Older clients that
     * predate this field simply store null.
     */
    let reportJson = null;
    const rawReportJson = (req.body?.reportJson ?? '').toString().trim();
    if (rawReportJson) {
      try {
        reportJson = JSON.parse(rawReportJson);
      } catch (err) {
        console.error('[inspection] reportJson was not valid JSON:', err.message);
        notes.push('Structured report JSON was malformed and not stored');
      }
    }

    // Accepts photos_<category> with or without the [] suffix the browser sends.
    const photos = (req.files || [])
      .map(file => {
        const match = /^photos_([a-z]+)(\[\])?$/i.exec(file.fieldname);
        return match ? { ...file, category: match[1].toLowerCase() } : null;
      })
      .filter(Boolean);

    // ---- HubSpot ----
    let contactId = null;
    try {
      contactId = await upsertContact(fields);
    } catch (err) {
      console.error('[inspection] contact upsert failed:', err);
      notes.push('HubSpot contact was not created');
    }

    try {
      const result = await createInspectionDeal(fields, contactId);
      dealId = result.dealId;
      if (result.closerWarning) {
        console.warn('[inspection]', result.closerWarning);
        notes.push(result.closerWarning);
      }
      if (result.setterWarning) {
        console.warn('[inspection]', result.setterWarning);
        notes.push(result.setterWarning);
      }
    } catch (err) {
      console.error('[inspection] deal creation failed:', err);
      notes.push('HubSpot deal was not created');
    }

    // ---- Supabase ----
    // Photos are keyed by deal id, so without one there is nowhere to put them.
    if (photos.length && dealId) {
      try {
        const { uploaded, failed, photosUrl: zipUrl } = await uploadPhotos(dealId, photos);
        photosUrl = zipUrl;

        /*
         * The report PDF is produced by /generate-pdf and filed under the same
         * bucket, so the gallery excludes that category. Nothing on this route
         * writes there any more — the filter is for files an older client may
         * still be sending.
         */
        photoUrls = uploaded
          .filter(item => item.category !== REPORT_PDF_CATEGORY)
          .map(({ url, category }) => ({ url, category }));
        if (failed.length) {
          console.error('[inspection] photo uploads failed:', failed);
          notes.push(`${failed.length} of ${photos.length} photos failed to upload`);
        }
        try {
          assertPipelineAllowed(INSPECTION_PIPELINE);
          await hubspot(`/crm/v3/objects/deals/${dealId}`, {
            method: 'PATCH',
            body: JSON.stringify({ properties: { inspection_photos_url: photosUrl } }),
          });
        } catch (err) {
          console.error('[inspection] could not write inspection_photos_url:', err);
          notes.push('Photo folder URL was not written to the deal');
        }
      } catch (err) {
        console.error('[inspection] Supabase upload failed:', err);
        notes.push('Photos were not uploaded to storage');
      }
    } else if (photos.length && !dealId) {
      notes.push('Photos were not uploaded — no deal id to file them under');
    }

    /*
     * Saved after the deal and photos so the row carries both. Best-effort like
     * everything above it: a failure here costs the shareable link, not the
     * submission, so it becomes a warning rather than an error.
     */
    try {
      reportId = await saveInspectionReport({ dealId, fields, damageReport, reportJson, photosUrl, photoUrls });
      console.log('[inspection] saved report', reportId, 'for deal', dealId);
    } catch (err) {
      console.error('[inspection] report save failed:', err);
      notes.push('Report was not saved — shareable link unavailable');
    }

    /*
     * The shareable link, mirrored onto the deal so ops can open the report
     * from HubSpot without going through the rep. Null whenever the save above
     * failed — there is no report row to point at.
     */
    reportUrl = reportId ? `${REPORT_PAGE_URL}?id=${reportId}` : null;

    if (reportUrl && dealId) {
      try {
        assertPipelineAllowed(INSPECTION_PIPELINE);
        await hubspot(`/crm/v3/objects/deals/${dealId}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties: { damage_report_url: reportUrl } }),
        });
      } catch (err) {
        console.error('[inspection] could not write damage_report_url:', err);
        notes.push('Report URL was not written to the deal');
      }
    }

    // ---- Ops email (always attempted, with whatever survived above) ----
    try {
      await resend.emails.send({
        from: 'NuHome Forms <noreply@thehiveoffice.com>',
        to: ['stacy@thenuhome.com'],
        subject: `New Inspection Submitted — ${[fields.fname, fields.lname].filter(Boolean).join(' ') || 'Unknown'} | ${fields.address || 'No address'}`,
        html: inspectionEmailHtml(fields, damageReport, photosUrl, photos.length, notes),
      });
    } catch (err) {
      console.error('[inspection] ops email failed:', err);
      notes.push('Ops email was not sent');
    }

    return res.json({
      success: true,
      dealId,
      reportId,
      reportUrl,
      photosUrl,
      damageReport,
      ...(notes.length ? { warnings: notes } : {}),
    });

  } catch (err) {
    console.error('[inspection] unhandled error:', err);
    // Never a bare 500 — the browser always gets JSON it can render.
    return res.status(500).json({
      success: false,
      error: err.message || 'Inspection submission failed.',
      dealId,
      photosUrl,
    });
  }
});

// ===========================================================================
// /generate-pdf — server-side inspection report PDF
//
// Replaces the jsPDF build that used to run in the rep's browser. Two reasons
// it moved: an iPhone was rendering every photo twice (once to draw the PDF,
// once for the on-screen preview) and running out of memory, and a PDF built
// on the phone could not be regenerated by ops without the rep redoing the
// inspection. The report is now reproducible from the deal id alone.
// ===========================================================================

const PDF_GOLD = '#C9A84C';
const PDF_NAVY = '#1B2A4A';
const PDF_INK = '#1a1a18';
const PDF_BODY = '#50504b';
const PDF_MUTED = '#888780';
const PDF_RULE = '#d6dce7';

const PDF_MARGIN = 48;
const PDF_HEADER_H = 40;
// Top margin clears the gold bar; bottom reserves the footer strip. Both are
// page margins so pdfkit's own pagination never lays text over either band.
const PDF_CONTENT_TOP = PDF_HEADER_H + 20;
const PDF_FOOTER_H = 44;

const PDF_PHOTO_W = 240;
const PDF_PHOTO_GAP = 16;
const PDF_CAPTION_H = 14;

/** Display order and labels for the photo groups. */
const PDF_PHOTO_CATEGORIES = [
  { key: 'establishing', label: 'Establishing Shots' },
  { key: 'damage', label: 'Damage Close-Ups' },
  { key: 'softmetal', label: 'Soft Metals' },
  { key: 'gutters', label: 'Gutters & Accessories' },
];

/** Title-cases an unrecognised category key so it still gets a real heading. */
function photoCategoryLabel(key) {
  const known = PDF_PHOTO_CATEGORIES.find(c => c.key === key);
  if (known) return known.label;
  return String(key || 'Photos').replace(/[-_]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

/** Collects a finished PDFDocument into a single Buffer. */
function pdfToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/*
 * The branded band across the top of every page. Registered on 'pageAdded', so
 * it fires for page one too — which is why the document is created with
 * autoFirstPage: false and the first page is added by hand.
 */
function drawPdfHeader(doc) {
  const w = doc.page.width;
  doc.save();
  doc.rect(0, 0, w, PDF_HEADER_H).fill(PDF_GOLD);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(15)
    .text('NuHome', PDF_MARGIN, 12, { lineBreak: false });
  doc.fillColor('#ffffff').font('Helvetica').fontSize(10)
    .text('Roofing Damage Inspection Report', PDF_MARGIN, 15, {
      width: w - PDF_MARGIN * 2,
      align: 'right',
      lineBreak: false,
    });
  doc.restore();
  // save/restore covers the graphics state but not the text cursor, so the
  // body would otherwise start writing wherever the header left off.
  doc.x = PDF_MARGIN;
  doc.y = PDF_CONTENT_TOP;
}

/*
 * Stamped in a second pass: the page count is not known until the body has been
 * laid out, and every page needs the same line. Requires bufferPages: true.
 */
function stampPdfFooters(doc, dateLabel) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    /*
     * The footer sits inside the bottom margin. Writing there with the margin
     * in force would make pdfkit break to a new page — which would then also
     * need a footer, and so on. Drop the margin for the one write.
     */
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor(PDF_MUTED).text(
      `Generated by NuHome — ${dateLabel}`,
      PDF_MARGIN,
      doc.page.height - 26,
      { width: doc.page.width - PDF_MARGIN * 2, align: 'center', lineBreak: false }
    );
    doc.page.margins.bottom = savedBottom;
  }
}

/**
 * Renders the report.
 *
 * `photos` are multer memory-storage files ({ buffer, originalname, category }).
 * Returns { buffer, skipped } — skipped names every photo that could not be
 * embedded, which is reported rather than thrown: a report missing one photo is
 * worth far more to ops than no report at all.
 */
async function buildInspectionPDF(reportData, photos) {
  const d = reportData || {};
  const skipped = [];

  const doc = new PDFDocument({
    size: 'LETTER',
    // Footers are stamped after the body, so every page must stay addressable.
    bufferPages: true,
    // So page one goes through the same 'pageAdded' header hook as the rest.
    autoFirstPage: false,
    margins: { top: PDF_CONTENT_TOP, bottom: PDF_FOOTER_H, left: PDF_MARGIN, right: PDF_MARGIN },
  });

  doc.on('pageAdded', () => drawPdfHeader(doc));
  doc.addPage();

  const contentW = () => doc.page.width - PDF_MARGIN * 2;
  const bottomLimit = () => doc.page.height - PDF_FOOTER_H;
  const ensureSpace = needed => {
    if (doc.y + needed > bottomLimit()) doc.addPage();
  };

  /** Section heading with the gold rule down its left edge. */
  const heading = label => {
    ensureSpace(40);
    doc.y += 10;
    const y = doc.y;
    doc.save();
    doc.rect(PDF_MARGIN, y, 3, 14).fill(PDF_GOLD);
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(13).fillColor(PDF_NAVY)
      .text(label, PDF_MARGIN + 11, y, { width: contentW() - 11 });
    doc.x = PDF_MARGIN;
    doc.y = y + 24;
  };

  const LABEL_W = 132;

  /** Label/value row. Long values wrap and the row grows to fit. */
  const fieldRow = (label, value) => {
    const text = (value == null || value === '') ? '—' : String(value);
    doc.font('Helvetica').fontSize(9);
    const labelH = doc.heightOfString(String(label), { width: LABEL_W - 8 });
    doc.font('Helvetica').fontSize(10);
    const valueH = doc.heightOfString(text, { width: contentW() - LABEL_W });
    const rowH = Math.max(labelH, valueH) + 7;

    ensureSpace(rowH);
    const y = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor(PDF_MUTED)
      .text(String(label), PDF_MARGIN, y + 1, { width: LABEL_W - 8 });
    doc.font('Helvetica').fontSize(10).fillColor(PDF_INK)
      .text(text, PDF_MARGIN + LABEL_W, y, { width: contentW() - LABEL_W });
    doc.x = PDF_MARGIN;
    doc.y = y + rowH;
  };

  const paragraph = text => {
    const body = String(text == null ? '' : text);
    if (!body.trim()) return;
    doc.font('Helvetica').fontSize(10).fillColor(PDF_BODY);
    // Let pdfkit paginate the block itself; it carries the margins forward and
    // each new page picks up the header via the 'pageAdded' hook.
    doc.text(body, PDF_MARGIN, doc.y, { width: contentW(), align: 'left' });
    doc.x = PDF_MARGIN;
    doc.y += 6;
  };

  // ---- Title block ----
  doc.font('Helvetica-Bold').fontSize(20).fillColor(PDF_INK)
    .text(String(d.customerName || 'Homeowner'), PDF_MARGIN, doc.y, { width: contentW() });
  doc.font('Helvetica').fontSize(11).fillColor(PDF_MUTED)
    .text(String(d.propertyAddress || 'Address not provided'), PDF_MARGIN, doc.y + 2, { width: contentW() });
  doc.y += 10;
  doc.save();
  doc.moveTo(PDF_MARGIN, doc.y).lineTo(doc.page.width - PDF_MARGIN, doc.y).strokeColor(PDF_RULE).stroke();
  doc.restore();
  doc.y += 14;

  // ---- Report fields ----
  heading('Inspection Details');
  fieldRow('Customer Name', d.customerName);
  fieldRow('Address', d.propertyAddress);
  fieldRow('Phone', d.customerPhone);
  fieldRow('Email', d.customerEmail);
  fieldRow('Inspection Date', d.inspectionDate);
  fieldRow('Inspected By', d.inspectedBy);
  fieldRow('Closer', d.closer);
  fieldRow('Setter', d.setter);

  // ---- Damage assessment ----
  const assessment = String(d.damageAssessment || '').trim();
  if (assessment) {
    heading('Damage Assessment');
    paragraph(assessment);
  }

  // ---- Checklist ----
  const checklist = Array.isArray(d.checklist) ? d.checklist : [];
  if (checklist.length) {
    heading('Inspection Checklist');
    for (const raw of checklist) {
      const item = raw && typeof raw === 'object' ? raw : { label: raw, checked: false };
      const label = String(item.label == null ? '' : item.label);
      if (!label) continue;

      doc.font('Helvetica').fontSize(10);
      const rowH = doc.heightOfString(label, { width: contentW() - 18 }) + 5;
      ensureSpace(rowH);
      const y = doc.y;

      if (item.checked) {
        /*
         * ZapfDingbats '4' is a check mark. The standard Helvetica the rest of
         * the document uses is WinAnsi-encoded and has no U+2713 at all — it
         * renders as a substituted glyph rather than a tick.
         */
        doc.font('ZapfDingbats').fontSize(9).fillColor(PDF_GOLD)
          .text('4', PDF_MARGIN, y + 1, { width: 14, lineBreak: false });
      } else {
        doc.font('Helvetica').fontSize(10).fillColor(PDF_MUTED)
          .text('–', PDF_MARGIN, y, { width: 14, lineBreak: false });
      }

      doc.font('Helvetica').fontSize(10).fillColor(item.checked ? PDF_INK : PDF_MUTED)
        .text(label, PDF_MARGIN + 18, y, { width: contentW() - 18 });
      doc.x = PDF_MARGIN;
      doc.y = y + rowH;
    }
  }

  // ---- Notes ----
  const notes = String(d.notes || '').trim();
  if (notes) {
    heading('Inspector Notes');
    paragraph(notes);
  }

  // ---- Photos ----
  const grouped = [];
  const seen = new Set();
  const pushGroup = key => {
    if (seen.has(key)) return;
    const items = (photos || []).filter(p => p.category === key);
    if (items.length) grouped.push({ key, label: photoCategoryLabel(key), items });
    seen.add(key);
  };
  PDF_PHOTO_CATEGORIES.forEach(c => pushGroup(c.key));
  // Anything the frontend sent under a category this build does not know about
  // still gets a group, so a photo is never silently dropped from the report.
  (photos || []).forEach(p => pushGroup(p.category));

  if (grouped.length) {
    doc.addPage();
    heading('Inspection Photos');

    for (const group of grouped) {
      // Room for the label and the first row beneath it — checking only the
      // label's own height would strand it at the foot of a page.
      if (doc.y + 200 > bottomLimit()) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(11).fillColor(PDF_NAVY)
        .text(group.label, PDF_MARGIN, doc.y, { width: contentW() });
      doc.x = PDF_MARGIN;
      doc.y += 14;

      let col = 0;
      let rowTop = doc.y;
      let rowH = 0;

      for (const photo of group.items) {
        const name = photo.originalname || 'photo';

        /*
         * openImage both validates and measures. pdfkit embeds JPEG and PNG
         * only — a HEIC straight off an iPhone throws here, which is exactly
         * the soft-skip case: note it and carry on with the rest.
         */
        let img = null;
        try {
          img = doc.openImage(photo.buffer);
        } catch (err) {
          console.warn('[generate-pdf] skipping photo pdfkit cannot decode:', name, err.message);
          skipped.push(name);
          continue;
        }
        if (!img || !img.width || !img.height) {
          skipped.push(name);
          continue;
        }

        const naturalH = PDF_PHOTO_W * (img.height / img.width);
        // Tallest a photo may be and still leave its caption on the page.
        const maxH = bottomLimit() - PDF_CONTENT_TOP - PDF_CAPTION_H;
        let drawH = Math.min(naturalH, maxH);

        if (col === 0) {
          if (doc.y + drawH + PDF_CAPTION_H > bottomLimit()) {
            doc.addPage();
          }
          rowTop = doc.y;
          rowH = 0;
        } else {
          // The second photo in a row may be taller than the first; it cannot
          // grow past the page the row already started on.
          drawH = Math.min(drawH, bottomLimit() - rowTop - PDF_CAPTION_H);
        }

        const x = PDF_MARGIN + col * (PDF_PHOTO_W + PDF_PHOTO_GAP);
        try {
          // `fit` scales inside the box without distorting the photo.
          doc.image(img, x, rowTop, { fit: [PDF_PHOTO_W, drawH] });
        } catch (err) {
          console.warn('[generate-pdf] skipping photo pdfkit could not draw:', name, err.message);
          skipped.push(name);
          continue;
        }

        const drawnH = Math.min(drawH, naturalH);
        doc.font('Helvetica').fontSize(7).fillColor(PDF_MUTED)
          .text(name, x, rowTop + drawnH + 3, { width: PDF_PHOTO_W, lineBreak: false, ellipsis: true });

        rowH = Math.max(rowH, drawnH + PDF_CAPTION_H);
        col += 1;
        if (col === 2) {
          doc.x = PDF_MARGIN;
          doc.y = rowTop + rowH + PDF_PHOTO_GAP;
          col = 0;
          rowH = 0;
        }
      }

      // Flush a half-filled final row before the next category heading.
      if (col === 1) {
        doc.x = PDF_MARGIN;
        doc.y = rowTop + rowH + PDF_PHOTO_GAP;
      }
      doc.y += 6;
    }

    if (skipped.length) {
      ensureSpace(30);
      doc.font('Helvetica').fontSize(8).fillColor(PDF_MUTED).text(
        `${skipped.length} photo(s) could not be embedded in this PDF. `
        + 'They are stored in full with the inspection photos.',
        PDF_MARGIN, doc.y, { width: contentW() }
      );
    }
  }

  stampPdfFooters(doc, d.inspectionDate || new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  }));

  const buffer = await pdfToBuffer(doc);
  return { buffer, skipped };
}

app.post('/generate-pdf', upload.any(), async (req, res) => {
  try {
    // Same soft-skip as /inspection: an oversized file drops out and the rest
    // of the report is still produced.
    const oversized = (req.files || []).filter(f => f.size > MAX_FILE_BYTES);
    const acceptedFiles = (req.files || []).filter(f => f.size <= MAX_FILE_BYTES);
    if (oversized.length) {
      console.warn('[generate-pdf] skipped oversized files:',
        oversized.map(f => `${f.originalname} (${(f.size / 1024 / 1024).toFixed(1)}MB)`));
    }

    const rawDealId = (req.body?.dealId ?? '').toString().trim();
    // The id becomes a storage path segment, so anything outside [\w.-] would
    // let a caller write outside the deal's own folder.
    const dealId = rawDealId.replace(/[^\w.-]/g, '');
    if (!dealId) {
      return res.status(400).json({ success: false, error: 'dealId is required.' });
    }

    const rawReportData = (req.body?.reportData ?? '').toString().trim();
    if (!rawReportData) {
      return res.status(400).json({ success: false, error: 'reportData is required.' });
    }
    let reportData;
    try {
      reportData = JSON.parse(rawReportData);
    } catch (err) {
      return res.status(400).json({ success: false, error: 'reportData was not valid JSON.' });
    }
    if (!reportData || typeof reportData !== 'object') {
      return res.status(400).json({ success: false, error: 'reportData must be a JSON object.' });
    }

    // Same fieldname convention as /inspection — photos_<category>[] — so the
    // report can group them. A bare photos_report[] lands in 'report'.
    const photos = acceptedFiles
      .map(file => {
        const match = /^photos_([a-z]+)(\[\])?$/i.exec(file.fieldname);
        return match ? { ...file, category: match[1].toLowerCase() } : null;
      })
      .filter(Boolean);

    console.log('[generate-pdf] deal', dealId, '-', photos.length, 'photo(s)');

    const { buffer, skipped } = await buildInspectionPDF(reportData, photos);

    const slug = addressSlug(reportData.propertyAddress || '');
    const dateStamp = new Date().toISOString().slice(0, 10);
    const filename = `NuHome-Inspection-${slug}-${dateStamp}.pdf`;
    const storagePath = `${dealId}/${REPORT_PDF_CATEGORY}/${filename}`;

    const supabase = createSupabaseClient();
    const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(storagePath, buffer, {
      contentType: 'application/pdf',
      upsert: true,
    });
    if (error) throw new Error(`Supabase upload failed: ${error.message}`);

    const pdfUrl =
      `https://${SUPABASE_PROJECT_REF}.supabase.co/storage/v1/object/public/${PHOTO_BUCKET}/${storagePath}`;

    const warnings = [];
    if (oversized.length) warnings.push(`${oversized.length} photo(s) over 25MB were not included in the PDF`);
    if (skipped.length) warnings.push(`${skipped.length} photo(s) could not be embedded in the PDF`);

    console.log('[generate-pdf] wrote', storagePath, buffer.length, 'bytes');
    return res.json({ success: true, pdfUrl, ...(warnings.length ? { warnings } : {}) });
  } catch (err) {
    // Never a bare 500 or a crash — the frontend treats a failed PDF as a
    // warning on an otherwise successful submission, and needs JSON to do it.
    console.error('[generate-pdf] failed:', err);
    return res.status(500).json({ success: false, error: err.message || 'PDF generation failed.' });
  }
});

// ===========================================================================
// PATCH /update-deal-pdf — write a generated report PDF onto the deal
//
// Split out from /inspection because the PDF does not exist yet when that route
// finishes: the frontend calls /generate-pdf with the deal id it just received,
// then brings the resulting URL back here.
// ===========================================================================

app.patch('/update-deal-pdf', async (req, res) => {
  try {
    const dealId = (req.body?.dealId ?? '').toString().trim();
    const pdfUrl = (req.body?.pdfUrl ?? '').toString().trim();

    if (!dealId) return res.status(400).json({ success: false, error: 'dealId is required.' });
    if (!pdfUrl) return res.status(400).json({ success: false, error: 'pdfUrl is required.' });

    /*
     * Unlike every other deal write in this service, the id here comes from the
     * caller rather than from a deal this service just created — so the
     * pipeline is read off the deal and checked, instead of asserting against a
     * constant. That is what actually keeps Ops/Install out of reach: a deal in
     * FORBIDDEN_PIPELINE is refused before any write is attempted.
     */
    const deal = await hubspot(
      `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=pipeline`
    );
    assertPipelineAllowed(deal?.properties?.pipeline);

    await hubspot(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { damage_report_url: pdfUrl } }),
    });

    console.log('[update-deal-pdf] wrote damage_report_url for deal', dealId);
    return res.json({ success: true });
  } catch (err) {
    console.error('[update-deal-pdf] failed:', err);
    return res.status(500).json({ success: false, error: err.message || 'Could not update the deal.' });
  }
});

// ===========================================================================
// /retail-submission — retail (non-insurance) site inspection intake
//
// Files and HubSpot only: no AI report, no PDF, no report row. The three
// document sections are zipped and stored separately so each has its own URL
// on the deal.
// ===========================================================================

/** Builds the deal properties shared by the create and update paths. */
function retailDealProperties(fields, { closer, setter }) {
  const properties = {
    pipeline: RETAIL_PIPELINE,
    dealstage: RETAIL_STAGE,
  };

  const dealname = String(fields.customerName || '').trim();
  if (dealname) properties.dealname = dealname;

  // Every field below is optional — write it when the rep filled it in, leave
  // whatever HubSpot already holds when they did not.
  if (fields.propertyAddress) properties.customers_full_address = fields.propertyAddress;
  if (fields.customerPhone) properties.customer_cell_phone = fields.customerPhone;
  if (fields.customerEmail) properties.customer_email = fields.customerEmail;
  if (fields.roofType) properties.roof_type = fields.roofType;
  if (fields.shingleColor) properties.shingle_color = fields.shingleColor;
  if (fields.dripEdgeColor) properties.drip_edge_color = fields.dripEdgeColor;
  if (fields.squares) properties.number_of_squares = fields.squares;
  if (fields.roofPitch) properties.roof_pitch = fields.roofPitch;
  if (fields.financingType) properties.financing_type = fields.financingType;
  if (fields.notes) properties.roofing_notes = fields.notes;
  if (closer) properties.closer = closer;
  if (setter) properties.setter = setter;

  return properties;
}

/**
 * Resolves repName/setterName against the live HubSpot enumerations, exactly
 * as /inspection does. A name that matches nothing drops the property rather
 * than failing the deal write, and says so in the warnings.
 */
async function resolveRetailPeople(fields) {
  const warnings = [];
  let closer = null;
  let setter = null;

  try {
    closer = await resolveCloserOption(fields.repName);
    if (!closer && fields.repName) {
      warnings.push(`No "closer" option matched rep "${fields.repName}" — property omitted.`);
    }
  } catch (err) {
    warnings.push(`Could not resolve "closer" options: ${err.message}`);
  }

  try {
    setter = await resolveSetterOption(fields.setterName);
    if (!setter && fields.setterName) {
      warnings.push(`No "setter" option matched "${fields.setterName}" — property omitted.`);
    }
  } catch (err) {
    warnings.push(`Could not resolve "setter" options: ${err.message}`);
  }

  return { closer, setter, warnings };
}

async function updateRetailDeal(deal, fields, people) {
  // Asserted against the pipeline HubSpot reports for this deal, not our own
  // constant, so a deal in the forbidden pipeline can never be patched.
  assertPipelineAllowed(deal.pipeline);

  const properties = retailDealProperties(fields, people);
  await hubspot(`/crm/v3/objects/deals/${deal.dealId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  });

  console.log('[retail-submission] updated deal', deal.dealId, 'with', Object.keys(properties).join(', '));
  return { dealId: deal.dealId, contactId: deal.contactId };
}

async function createRetailDeal(fields, people) {
  assertPipelineAllowed(RETAIL_PIPELINE);

  const { fname, lname } = splitCustomerName(fields.customerName);
  const contactId = await upsertContact({
    fname,
    lname,
    customer_email: fields.customerEmail,
    phone: fields.customerPhone,
    address: fields.propertyAddress,
  });

  const properties = retailDealProperties(fields, people);
  if (!properties.dealname) properties.dealname = 'Unknown homeowner';

  const deal = await hubspot('/crm/v3/objects/deals', {
    method: 'POST',
    body: JSON.stringify({ properties }),
  });

  if (contactId) {
    await hubspot(
      `/crm/v4/objects/deals/${deal.id}/associations/default/contacts/${contactId}`,
      { method: 'PUT' }
    );
  }

  console.log('[retail-submission] created deal', deal.id, 'and contact', contactId, 'with', Object.keys(properties).join(', '));
  return { dealId: deal.id, contactId };
}

function retailEmailHtml(fields, sectionUrls, dealId, warnings) {
  const rows = [
    ['Customer', fields.customerName],
    ['Property address', fields.propertyAddress],
    ['Phone', fields.customerPhone],
    ['Email', fields.customerEmail],
    ['Closer', fields.repName],
    ['Setter', fields.setterName],
    ['Roof type', fields.roofType],
    ['Shingle color', fields.shingleColor],
    ['Drip edge color', fields.dripEdgeColor],
    ['Squares', fields.squares],
    ['Pitch', fields.roofPitch],
    ['Financing type', fields.financingType],
    ['Notes / expectations', fields.notes],
  ]
    .map(([label, value]) => `
      <tr>
        <td style="padding:6px 12px 6px 0;color:#6b7280;font-size:13px;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>
        <td style="padding:6px 0;color:#111827;font-size:13px">${escapeHtml(value || '—')}</td>
      </tr>`)
    .join('');

  const fileLinks = RETAIL_SECTIONS
    .map(section => {
      const url = sectionUrls[section.field];
      return url
        ? `<p style="margin:6px 0;font-size:13px"><a href="${escapeHtml(url)}" style="color:#C9922A">${escapeHtml(section.label)} →</a></p>`
        : `<p style="margin:6px 0;color:#6b7280;font-size:13px">${escapeHtml(section.label)} — storage link unavailable.</p>`;
    })
    .join('');

  const dealBlock = dealId
    ? `<p style="margin:16px 0 0;font-size:13px"><a href="https://app.hubspot.com/contacts/deals/${escapeHtml(dealId)}" style="color:#C9922A">Open the HubSpot deal →</a></p>`
    : `<p style="margin:16px 0 0;color:#6b7280;font-size:13px">HubSpot deal unavailable.</p>`;

  const noteBlock = warnings.length
    ? `<p style="margin:16px 0 0;color:#b45309;font-size:12px">Partial submission — ${escapeHtml(warnings.join(' · '))}</p>`
    : '';

  return `
    <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto;">
      <div style="background:#1B2A4A;padding:24px;border-radius:8px 8px 0 0">
        <h1 style="color:#C9922A;margin:0;font-size:20px">NuHome — Retail Submission Submitted</h1>
      </div>
      <div style="background:#f9fafb;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px">
        <table style="width:100%;border-collapse:collapse">${rows}</table>
        <h2 style="font-size:14px;margin:24px 0 8px;color:#111827">Documents &amp; photos</h2>
        ${fileLinks}
        ${dealBlock}
        ${noteBlock}
      </div>
    </div>
  `;
}

app.post('/retail-submission', upload.any(), async (req, res) => {
  /*
   * Drop files over the per-file cap and keep going, same as /inspection:
   * multer does not enforce it, so an oversized file arrives fully buffered
   * and is discarded here rather than failing the whole submission.
   */
  const oversized = (req.files || []).filter(f => f.size > MAX_FILE_BYTES);
  const acceptedFiles = (req.files || []).filter(f => f.size <= MAX_FILE_BYTES);
  req.files = acceptedFiles;
  if (oversized.length) {
    console.warn('[retail-submission] skipped oversized files:', oversized.map(f => `${f.originalname} (${(f.size / 1024 / 1024).toFixed(1)}MB)`));
  }

  // Total cap applies to what survived the filter, not what was sent.
  const totalBytes = acceptedFiles.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
    return res.status(400).json({
      success: false,
      error: 'FILE_TOO_LARGE',
      message: 'Total upload size exceeds 200MB. Please remove some files and try again.',
    });
  }

  const warnings = [];
  if (oversized.length) {
    warnings.push(`${oversized.length} file(s) over 25MB were skipped — ask rep to compress before resubmitting`);
  }

  let dealId = null;
  const sectionUrls = {};

  const FIELDS = [
    'repName', 'setterName', 'customerName', 'customerPhone', 'customerEmail',
    'propertyAddress', 'roofType', 'shingleColor', 'dripEdgeColor', 'squares',
    'roofPitch', 'financingType', 'notes',
  ];

  try {
    const fields = {};
    for (const key of FIELDS) fields[key] = (req.body?.[key] ?? '').toString().trim();

    if (!fields.repName) {
      return res.status(400).json({ success: false, error: 'Rep name is required.' });
    }
    if (!fields.propertyAddress) {
      return res.status(400).json({ success: false, error: 'Property address is required.' });
    }

    // Accepts the fieldname with or without the [] suffix the browser sends.
    const filesBySection = {};
    for (const section of RETAIL_SECTIONS) {
      filesBySection[section.field] = (req.files || []).filter(file => {
        const name = String(file.fieldname || '').replace(/\[\]$/, '');
        return name === section.field;
      });
    }

    const missing = RETAIL_SECTIONS.filter(s => !filesBySection[s.field].length);
    if (missing.length) {
      return res.status(400).json({
        success: false,
        // Oversized files are dropped before this check, so a section can be
        // empty here purely because everything in it was too large.
        error: oversized.length
          ? `No usable files for: ${missing.map(s => s.label).join(', ')}. Files over 25MB were skipped — compress and resubmit.`
          : `At least one file is required for: ${missing.map(s => s.label).join(', ')}.`,
      });
    }

    console.log('[retail-submission] files received:',
      RETAIL_SECTIONS.map(s => `${s.field}=${filesBySection[s.field].length}`).join(' '));

    // ---- HubSpot: resolve people, then find or create the deal ----
    const people = await resolveRetailPeople(fields);
    for (const warning of people.warnings) {
      console.warn('[retail-submission]', warning);
      warnings.push(warning);
    }

    try {
      const existing = await findDealByAddress(fields.propertyAddress, fields.customerName, RETAIL_PIPELINE);
      if (existing) {
        const result = await updateRetailDeal(existing, fields, people);
        dealId = result.dealId;
      } else {
        const result = await createRetailDeal(fields, people);
        dealId = result.dealId;
      }
    } catch (err) {
      console.error('[retail-submission] HubSpot deal write failed:', err);
      warnings.push('HubSpot deal was not created or updated');
    }

    // ---- Supabase: one zip per section, filed under the deal ----
    // Keyed by deal id, so without one there is nowhere to put them.
    if (dealId) {
      for (const section of RETAIL_SECTIONS) {
        try {
          const result = await uploadFilesAndZip({
            bucket: PHOTO_BUCKET,
            slug: `${dealId}/${section.folder}`,
            files: filesBySection[section.field],
            zipName: section.zipName,
            label: `[retail-submission] ${section.label}`,
          });
          sectionUrls[section.field] = result.zipUrl;
          if (result.failed.length) {
            console.error(`[retail-submission] ${section.label} storage failures:`, result.failed);
            warnings.push(`${result.failed.length} ${section.label.toLowerCase()} file(s) failed to upload`);
          }
        } catch (err) {
          console.error(`[retail-submission] ${section.label} upload failed:`, err);
          warnings.push(`${section.label} was not uploaded to storage`);
        }
      }

      // Written after the uploads because the URLs are only known once the
      // zips exist. Only the sections that produced a URL are patched.
      const urlProperties = {};
      for (const section of RETAIL_SECTIONS) {
        if (sectionUrls[section.field]) urlProperties[section.property] = sectionUrls[section.field];
      }
      if (Object.keys(urlProperties).length) {
        try {
          assertPipelineAllowed(RETAIL_PIPELINE);
          await hubspot(`/crm/v3/objects/deals/${dealId}`, {
            method: 'PATCH',
            body: JSON.stringify({ properties: urlProperties }),
          });
        } catch (err) {
          console.error('[retail-submission] could not write file URLs:', err);
          warnings.push('File URLs were not written to the deal');
        }
      }
    } else {
      warnings.push('Files were not uploaded — no deal id to file them under');
    }

    // ---- Ops email (always attempted, with whatever survived above) ----
    try {
      await resend.emails.send({
        from: 'NuHome Forms <noreply@thehiveoffice.com>',
        to: ['misty@thenuhome.com', 'mariah@thenuhome.com'],
        subject: `New Retail Submission — ${fields.customerName || 'Unknown'} | ${fields.propertyAddress}`,
        html: retailEmailHtml(fields, sectionUrls, dealId, warnings),
      });
    } catch (err) {
      console.error('[retail-submission] ops email failed:', err);
      warnings.push('Ops email was not sent');
    }

    return res.json({
      success: true,
      dealId,
      measurementReportUrl: sectionUrls.measurement_report || null,
      signedEstimateUrl: sectionUrls.signed_estimate || null,
      sitePhotosUrl: sectionUrls.site_photos || null,
      ...(warnings.length ? { warnings } : {}),
    });

  } catch (err) {
    console.error('[retail-submission] unhandled error:', err);
    // Never a bare 500 — the browser always gets JSON it can render.
    return res.status(500).json({
      success: false,
      error: err.message || 'Retail submission failed.',
      dealId,
      warnings,
    });
  }
});

// ===========================================================================
// /scope — scope of loss intake from the Stage 8 button on the roofing guide
// ===========================================================================

async function updateScopeDeal(deal, zipUrl) {
  // Asserted against the pipeline HubSpot reports for this deal, not our own
  // constant, so a deal in the forbidden pipeline can never be patched.
  assertPipelineAllowed(deal.pipeline);

  const properties = { dealstage: SCOPE_REVIEW_STAGE };
  if (zipUrl) properties.scope_document_url = zipUrl;

  await hubspot(`/crm/v3/objects/deals/${deal.dealId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  });

  console.log('[scope] deal', deal.dealId, 'moved to Scope Received/Review with', Object.keys(properties).join(', '));
}

function scopeEmailHtml(homeownerName, propertyAddress, scopeUrl, submittedDate, fileCount, warnings) {
  const linkBlock = scopeUrl
    ? `<p style="margin:0 0 12px"><a href="${escapeHtml(scopeUrl)}" style="color:#C9922A">Download scope of loss (${fileCount} file${fileCount === 1 ? '' : 's'}) →</a></p>`
    : `<p style="margin:0 0 12px;color:#6b7280">${fileCount} file${fileCount === 1 ? '' : 's'} received — storage link unavailable.</p>`;

  const warnBlock = warnings.length
    ? `<p style="margin:16px 0 0;color:#b45309;font-size:12px">Partial submission — ${escapeHtml(warnings.join(' · '))}</p>`
    : '';

  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background:#1B2A4A;padding:24px;border-radius:8px 8px 0 0">
        <h1 style="color:#C9922A;margin:0;font-size:20px">NuHome — Scope of Loss Received</h1>
      </div>
      <div style="background:#f9fafb;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px">
        <p style="margin:0 0 12px"><strong>Homeowner:</strong> ${escapeHtml(homeownerName)}</p>
        <p style="margin:0 0 12px"><strong>Property address:</strong> ${escapeHtml(propertyAddress)}</p>
        ${linkBlock}
        <p style="margin:0;color:#6b7280;font-size:13px"><strong>Submitted:</strong> ${escapeHtml(submittedDate)}</p>
        ${warnBlock}
      </div>
    </div>
  `;
}

app.post('/scope', upload.any(), async (req, res) => {
  /*
   * Drop files over the per-file cap and keep going. multer no longer enforces
   * this, so an oversized file arrives fully buffered and is discarded here.
   */
  const oversized = (req.files || []).filter(f => f.size > MAX_FILE_BYTES);
  const acceptedFiles = (req.files || []).filter(f => f.size <= MAX_FILE_BYTES);
  req.files = acceptedFiles;
  if (oversized.length) {
    console.warn('Skipped oversized files:', oversized.map(f => `${f.originalname} (${(f.size / 1024 / 1024).toFixed(1)}MB)`));
  }

  // Total cap applies to what survived the filter, not what was sent.
  const totalBytes = acceptedFiles.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
    return res.status(400).json({
      success: false,
      error: 'FILE_TOO_LARGE',
      message: 'Total upload size exceeds 200MB. Please remove some photos and try again.',
    });
  }

  const warnings = [];
  let scopeUrl = null;
  let dealId = null;

  try {
    const propertyAddress = (req.body?.propertyAddress ?? '').toString().trim();
    // Placeholder is display-only. The lookup reads req.body directly so a blank
    // name scores neutral rather than matching against "Unknown Homeowner".
    const homeownerName = (req.body?.homeownerName ?? '').toString().trim() || 'Unknown Homeowner';
    const files = req.files || [];

    if (!propertyAddress) {
      return res.status(400).json({ success: false, error: 'Property address is required.' });
    }
    if (oversized.length && files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'All attached files exceeded the 25MB size limit. Please compress and resubmit.',
      });
    }
    if (!files.length) {
      return res.status(400).json({ success: false, error: 'At least one file is required.' });
    }

    const slug = addressSlug(propertyAddress);

    // ---- Supabase ----
    try {
      const result = await uploadFilesAndZip({
        bucket: SCOPE_BUCKET,
        slug,
        files,
        zipName: SCOPE_ZIP_NAME,
        label: '[scope]',
      });
      scopeUrl = result.zipUrl;
      if (result.failed.length) {
        console.error('[scope] storage failures:', result.failed);
        warnings.push(`${result.failed.length} file(s) failed to upload to storage`);
      }
    } catch (err) {
      console.error('[scope] Supabase upload failed:', err);
      warnings.push('Files were not uploaded to storage');
    }

    // ---- HubSpot ----
    try {
      const deal = await findDealByAddress(propertyAddress, submittedHomeownerName(req.body));
      if (deal) {
        await updateScopeDeal(deal, scopeUrl);
        dealId = deal.dealId;
      } else {
        console.warn('[scope] no Roofing - Insurance deal found for address:', propertyAddress);
        warnings.push('No matching HubSpot deal found — nothing was updated');
      }
    } catch (err) {
      console.error('[scope] HubSpot deal update failed:', err);
      warnings.push('HubSpot deal was not updated');
    }

    // ---- Ops email (always attempted, with whatever survived above) ----
    const submittedDate = new Date().toLocaleString('en-US', {
      timeZone: 'America/Denver', dateStyle: 'full', timeStyle: 'short',
    });
    try {
      await resend.emails.send({
        from: 'NuHome Forms <noreply@thehiveoffice.com>',
        to: ['stacy@thenuhome.com', 'taylor@thenuhome.com'],
        subject: `Scope of Loss Received — ${homeownerName} | ${propertyAddress}`,
        html: scopeEmailHtml(homeownerName, propertyAddress, scopeUrl, submittedDate, files.length, warnings),
      });
    } catch (err) {
      console.error('[scope] ops email failed:', err);
      warnings.push('Ops email was not sent');
    }

    return res.json({ success: true, scopeUrl, dealId, warnings });

  } catch (err) {
    console.error('[scope] unhandled error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Scope submission failed.',
      scopeUrl,
      dealId,
      warnings,
    });
  }
});

// ---- AI damage report proxy -----------------------------------------------
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const REPORT_MODEL = 'claude-sonnet-4-6';

/*
 * The prompt lives here rather than in the browser so the API key never has to.
 * The frontend posts raw form fields and gets a parsed report object back.
 */
function buildReportPrompt(d) {
  return `You are generating a professional roofing damage report for NÜ HOME, a roofing company in western Colorado. This report will be read by homeowners and insurance adjusters. It must be factual, specific, and written to support an insurance claim where warranted.

Generate a JSON damage report with these exact keys:
{
  "summary": "3-4 sentence executive summary. Lead with the storm event and confirmed damage. Reference the specific hail size and how it affects shingle integrity. State clearly whether a claim is warranted and why. Use professional insurance language.",
  "badge": "one of: ACTION REQUIRED | INSURANCE CLAIM RECOMMENDED | RETAIL REPLACEMENT RECOMMENDED | NO ACTION REQUIRED",
  "findings": [
    { 
      "label": "Finding title — be specific, e.g. 'Hail Impact — Field Shingles, All Slopes'", 
      "description": "3-5 sentences. Describe exactly what was observed and where. Explain the functional consequence of this damage (waterproofing integrity, rated service life, accelerated weathering). For hail: explain that impact bruising fractures the shingle mat, displaces protective granules, and exposes the asphalt substrate to UV degradation. For soft metals: explain that fresh dents on vent caps, flashing, and pipe boots confirm the hail event date and size — adjusters use soft metals to corroborate storm damage claims because they cannot be faked or walked on. For granule loss: reference that granules are the shingle's UV shield and their loss accelerates deterioration exponentially. Quantify where possible — reference hail size, number of slopes affected, squares involved.", 
      "severity": "high|medium|low" 
    }
  ],
  "recommendations": [
    { 
      "label": "Recommendation title", 
      "description": "2-3 sentences. Be directive. Reference the specific carrier by name where applicable. Explain what happens if this recommendation is not followed. Use language adjusters recognize — 'insurable loss', 'full replacement vs spot repair', 'storm date', 'scope of loss'.", 
      "type": "primary|secondary" 
    }
  ]
}

Inspection data:
- Address: ${d.address}
- Homeowner: ${d.fname} ${d.lname}
- Homeowner email: ${d.customer_email || 'not provided'}
- Carrier: ${d.carrier}
- Storm date: ${d.stormDate || 'recent storm'}
- Damage types found: ${d.damagePills ? d.damagePills.join(', ') : 'none specified'}
- Hail size: ${d.hailSize || 'unknown'}
- Overall severity: ${d.severity}
- Roof pitch: ${d.pitch}
- Stories: ${d.stories}
- Roof size: ${d.squares ? d.squares + ' squares' : 'unknown'}
- Roof age: ${d.roofAge || 'unknown'}
- Inspector notes: ${d.notes || 'none'}
- Recommendation: ${d.recommendation}
- Areas inspected: ${d.checklist ? d.checklist.filter(c => c.checked).map(c => c.label).join(', ') : 'full inspection performed on all accessible roof planes'}

Key guidance:
- Soft metal damage (vent caps, flashing, pipe boots, gutters) is critical to mention — it is the adjuster's primary tool for confirming hail event date and size. Always explain this if soft metals were inspected.
- Hail size matters: marble (1/2") causes moderate-severe bruising on standard 3-tab and architectural shingles. Golf ball (1.75") causes severe fracturing. Always connect hail size to expected damage pattern.
- Roof age matters: a 20+ year roof with storm damage is a replacement, not a repair. Reference manufacturer lifespan.
- Never recommend spot repair when damage is distributed across multiple slopes.
- Write findings as if an adjuster will read them and use them to approve or deny a claim.

Return ONLY the JSON object, no markdown, no preamble.`;
}

/*
 * Internal use only — no auth. The endpoint holds an API key, so anyone who can
 * reach it can spend against it; it is not linked from anywhere public, but
 * that is obscurity, not a control. Add a shared secret if it ever leaks.
 */
app.post('/report', async (req, res) => {
  try {
    const inspectionData = req.body?.inspectionData;
    if (!inspectionData || typeof inspectionData !== 'object') {
      return res.status(400).json({ error: 'inspectionData object is required.' });
    }

    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: REPORT_MODEL,
        /*
         * Raised from 1000 alongside the longer prompt. The report now asks for
         * a 3-4 sentence summary, 3-5 sentences per finding, and 2-3 per
         * recommendation, which runs past 1000 tokens on a typical multi-slope
         * inspection. Truncation lands mid-JSON, so the parse below throws and
         * the whole call degrades to the frontend's generic fallback report —
         * silently, and exactly on the detailed reports this prompt is for.
         */
        max_tokens: 4000,
        messages: [{ role: 'user', content: buildReportPrompt(inspectionData) }],
      }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      // Anthropic returns { error: { type, message } } on failure.
      throw new Error(payload?.error?.message || `Anthropic returned HTTP ${response.status}`);
    }

    /*
     * A refusal comes back as a normal 200 with an empty content array, so read
     * stop_reason before indexing into it.
     */
    if (payload?.stop_reason === 'refusal') {
      throw new Error('Anthropic declined the request.');
    }

    /*
     * Truncated output is invalid JSON, and the parse error alone gives no clue
     * why — name the cause so a future max_tokens squeeze is one log line to
     * diagnose rather than a mystery fallback report.
     */
    if (payload?.stop_reason === 'max_tokens') {
      throw new Error('Report was truncated at max_tokens — raise the limit.');
    }

    const text = (payload?.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
    if (!text) throw new Error('Anthropic returned no text content.');

    // The model is asked for bare JSON but occasionally wraps it in a fence.
    const report = JSON.parse(text.replace(/```json|```/g, '').trim());

    console.log('[report] generated for', inspectionData.address || 'unknown address');
    return res.json(report);
  } catch (err) {
    console.error('[report] generation failed:', err);
    return res.status(500).json({ error: 'Report generation failed' });
  }
});

/*
 * Public by design — the uuid is the capability. Anyone holding the link can
 * read the report, so it carries the homeowner's contact details to whoever it
 * is forwarded to; that is the same exposure as the link itself.
 *
 * Distinct from POST /report above (the AI generation proxy) — same path, and
 * only the method and the :reportId segment separate them.
 */
app.get('/report/:reportId', async (req, res) => {
  const { reportId } = req.params;

  // PostgREST answers a malformed uuid with a 400 and a Postgres cast error;
  // checking the shape here keeps that from surfacing as a 500.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reportId)) {
    return res.status(404).json({ error: 'Report not found' });
  }

  try {
    const { endpoint, headers } = supabaseRest(
      `${REPORTS_TABLE}?id=eq.${encodeURIComponent(reportId)}&select=report_data,photos_url&limit=1`
    );
    const response = await fetch(endpoint, { headers });
    const rows = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(rows?.message || `Supabase returned HTTP ${response.status}`);
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    /*
     * photos_url is a sibling column, not part of report_data — merged in here
     * so the report page can offer the photo zip without a second request.
     */
    return res.json({ ...(rows[0].report_data || {}), photosUrl: rows[0].photos_url || null });
  } catch (err) {
    console.error('[report] fetch failed:', err);
    return res.status(500).json({ error: 'Could not load report' });
  }
});

// ===========================================================================
// /rep-deals — rep-facing deal status board (public/rep-dashboard.html)
//
// No auth, same as /report: internal use on a known URL. Reads and writes are
// confined to the two roofing pipelines by the same guard every other route
// uses, and stage advancement is capped well short of the ops-only stages.
// ===========================================================================

/*
 * The adjuster name/phone/email trio is fetched alongside the required set so
 * the rep dashboard's adjuster form opens pre-filled with whatever is already
 * on the deal, rather than looking blank and inviting a re-type.
 */
const REP_DEAL_PROPERTIES = [
  'hs_object_id', 'dealname', 'customers_full_address', 'dealstage', 'pipeline',
  'hs_lastmodifieddate', 'adjuster_meeting_date', 'closer', 'setter', 'amount',
  'adjuster_name', 'adjuster_phone', 'adjuster_email',
];

/*
 * Stage ids this service reasons about by name.
 *
 * Reps no longer move deals through a sequence — the only stage change they can
 * cause is the one below, and it happens as a side effect of logging the
 * adjuster appointment rather than as a step they choose. Everything else is
 * ops-owned and unreachable from here.
 */
const CONTINGENCY_SIGNED_STAGE_ID = '4109489900';
const ADJUSTER_MEETING_STAGE_ID = '4109489901';

// Closed Won / Closed Lost in both roofing pipelines. "Open" means none of these.
const CLOSED_STAGE_IDS = [
  '4109489907', '4109489908', // Roofing - Insurance
  '4106670809', '4106670810', // Roofing - Retail
];

/** The common shape both dashboards render a deal from. */
function mapDealRow(row) {
  const p = row.properties || {};
  return {
    dealId: String(p.hs_object_id || row.id),
    dealname: p.dealname || '',
    address: p.customers_full_address || '',
    dealstage: String(p.dealstage || ''),
    pipeline: String(p.pipeline || ''),
    lastModified: p.hs_lastmodifieddate || null,
    adjusterMeetingDate: p.adjuster_meeting_date || null,
    adjusterName: p.adjuster_name || null,
    adjusterPhone: p.adjuster_phone || null,
    adjusterEmail: p.adjuster_email || null,
    closer: p.closer || null,
    setter: p.setter || null,
    amount: p.amount || null,
  };
}

/**
 * Resolves a typed name against the live `closer` and `setter` enumerations.
 *
 * Reuses resolveDealEnumOption — the same matcher the intake routes use, so a
 * rep who types the name the way they always have gets the same answer here.
 * The two properties carry different option lists, and a rep can appear on one,
 * the other, or both.
 */
async function resolveRepIdentities(repName) {
  const [closer, setter] = await Promise.all([
    resolveCloserOption(repName).catch(err => {
      console.error('[rep-deals] could not resolve closer options:', err.message);
      return null;
    }),
    resolveSetterOption(repName).catch(err => {
      console.error('[rep-deals] could not resolve setter options:', err.message);
      return null;
    }),
  ]);
  return { closer, setter };
}

/** Walks the search cursor to the end — a busy rep can hold more than one page. */
async function searchRepDeals({ closer, setter }) {
  // filterGroups are OR'd, filters inside one are AND'd. One group per role, each
  // pinned to the two roofing pipelines, gives
  // (closer = rep OR setter = rep) AND pipeline IN (insurance, retail).
  const pipelineFilter = {
    propertyName: 'pipeline',
    operator: 'IN',
    values: [INSPECTION_PIPELINE, RETAIL_PIPELINE],
  };
  const filterGroups = [];
  if (closer) filterGroups.push({ filters: [{ propertyName: 'closer', operator: 'EQ', value: closer }, pipelineFilter] });
  if (setter) filterGroups.push({ filters: [{ propertyName: 'setter', operator: 'EQ', value: setter }, pipelineFilter] });
  if (!filterGroups.length) return [];

  const collected = [];
  let after;
  // Bounded so a runaway cursor cannot spin forever; 10 pages is 1000 deals,
  // far past any single rep's book.
  for (let page = 0; page < 10; page += 1) {
    const body = {
      filterGroups,
      properties: REP_DEAL_PROPERTIES,
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      limit: 100,
      ...(after ? { after } : {}),
    };
    const search = await hubspot('/crm/v3/objects/deals/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    collected.push(...(search?.results || []));
    after = search?.paging?.next?.after;
    if (!after) break;
  }
  return collected;
}

app.get('/rep-deals', async (req, res) => {
  const repName = String(req.query.name || '').trim();
  if (!repName) {
    return res.status(400).json({ success: false, error: 'A rep name is required.' });
  }

  try {
    const identities = await resolveRepIdentities(repName);
    if (!identities.closer && !identities.setter) {
      console.log('[rep-deals] no closer/setter option matched', JSON.stringify(repName));
      return res.json({ success: true, repName, matched: null, insurance: [], retail: [] });
    }

    const results = await searchRepDeals(identities);

    const insurance = [];
    const retail = [];
    for (const row of results) {
      const p = row.properties || {};
      const pipeline = String(p.pipeline || '');

      // Structurally impossible given the search filter, but the guard is cheap
      // and this is the one place deal data leaves the service.
      if (pipeline !== INSPECTION_PIPELINE && pipeline !== RETAIL_PIPELINE) continue;

      const isCloser = !!identities.closer && p.closer === identities.closer;
      const isSetter = !!identities.setter && p.setter === identities.setter;

      const deal = {
        ...mapDealRow(row),
        // A rep who both set and closed the deal generated it themselves.
        role: isCloser && isSetter ? 'SELF GEN' : isCloser ? 'CLOSER' : 'SETTER',
      };

      (pipeline === INSPECTION_PIPELINE ? insurance : retail).push(deal);
    }

    console.log('[rep-deals]', JSON.stringify(repName),
      '- matched closer:', identities.closer, 'setter:', identities.setter,
      '- insurance:', insurance.length, 'retail:', retail.length);

    return res.json({
      success: true,
      repName,
      matched: { closer: identities.closer, setter: identities.setter },
      insurance,
      retail,
    });
  } catch (err) {
    console.error('[rep-deals] lookup failed:', err);
    return res.status(500).json({ success: false, error: 'Could not load deals from HubSpot.' });
  }
});

/*
 * Note to Deal, in HubSpot's default association catalogue. The v1 engagements
 * API this replaces is deprecated; a note created here is the same activity-feed
 * entry it produced.
 */
const NOTE_TO_DEAL_ASSOCIATION_TYPE_ID = 214;

/** YYYY-MM-DD, which is what HubSpot accepts for a `date` property. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The adjuster fields a rep may set, and the form field each comes from. */
const ADJUSTER_TEXT_FIELDS = ['adjuster_name', 'adjuster_phone', 'adjuster_email'];

/*
 * Stage id -> label for both roofing pipelines. Only the ops emails below read
 * this; the dashboards carry their own copy because they render stage names on
 * every card. Ids are unique across the two pipelines even where labels repeat.
 */
const STAGE_LABELS = {
  // Roofing - Insurance
  '4130205409': 'Site Inspection',
  '4109489900': 'Contingency Signed',
  '4109489901': 'Adjuster Meeting',
  '4109489902': 'Pending Scope',
  '4109489903': 'Scope Received/Review',
  '4142270177': 'Contract Signed',
  '4177282790': 'Welcome Call Ready',
  '4109490882': 'Permits',
  '4109489904': 'Install',
  '4109489905': 'Supplement (if needed)',
  '4109489906': 'Inspection',
  '4109490883': 'Funding Complete',
  '4109489907': 'Closed Won',
  '4109489908': 'Closed Lost',
  // Roofing - Retail
  '4106670802': 'Intake',
  '4177295046': 'Welcome Call Ready',
  '4106670803': 'Site Inspection',
  '4106670804': 'Design & Engineering',
  '4106670805': 'Permitting',
  '4106670806': 'Install',
  '4106670807': 'Inspection',
  '4106670808': 'Funding Complete',
  '4106670809': 'Closed Won',
  '4106670810': 'Closed Lost',
};

/*
 * The dashboard sends the label it already displays, but a raw stage id is
 * accepted too so the email never reads as a bare number to whoever opens it.
 */
function stageLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Unknown stage';
  return STAGE_LABELS[raw] || raw;
}

const HUBSPOT_DEAL_URL = 'https://app.hubspot.com/contacts/242443515/record/0-3';

/*
 * The two request emails differ only in wording, so they share a body. Every
 * interpolated field is rep-typed text arriving over an unauthenticated route —
 * escaped, or a customer name containing markup renders as live HTML in Misty's
 * and Mariah's inboxes.
 */
function dealRequestEmailHtml({ heading, lead, repName, customerName, address, currentStage, dealId }) {
  const rows = [
    ['Requested by', repName || 'Unknown rep'],
    ['Customer', customerName || 'Unknown'],
    ['Property address', address || '—'],
    ['Current stage', stageLabel(currentStage)],
  ]
    .map(([label, value]) => `
      <tr>
        <td style="padding:6px 12px 6px 0;color:#6b7280;font-size:13px;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>
        <td style="padding:6px 0;color:#111827;font-size:13px">${escapeHtml(value)}</td>
      </tr>`)
    .join('');

  return `
    <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto;">
      <div style="background:#1B2A4A;padding:24px;border-radius:8px 8px 0 0">
        <h1 style="color:#C9922A;margin:0;font-size:20px">NuHome — ${escapeHtml(heading)}</h1>
      </div>
      <div style="background:#f9fafb;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px">
        <p style="margin:0 0 16px;color:#111827;font-size:13px;line-height:1.6">${escapeHtml(lead)}</p>
        <table style="width:100%;border-collapse:collapse">${rows}</table>
        <p style="margin:20px 0 0;font-size:13px">
          <a href="${HUBSPOT_DEAL_URL}/${encodeURIComponent(dealId)}" style="color:#C9922A">Open the HubSpot deal →</a>
        </p>
        <p style="margin:16px 0 0;color:#6b7280;font-size:12px;line-height:1.5">
          Sent from the rep dashboard. Nothing was changed in HubSpot — this is a request for ops to action.
        </p>
      </div>
    </div>
  `;
}

/*
 * Wording for each request type, keyed by the action that raises it. Both are
 * notifications only: no HubSpot call happens on either path, which is why they
 * are handled before the deal is ever fetched.
 */
const DEAL_REQUESTS = {
  lost: {
    subjectPrefix: 'Deal Lost Request',
    heading: 'Deal Lost Request',
    lead: 'A rep has asked for this deal to be marked lost. Nothing has been changed in HubSpot.',
  },
  retail: {
    subjectPrefix: 'Move to Retail Request',
    heading: 'Move to Retail Request',
    lead: 'A rep has asked for this deal to be moved to the Roofing - Retail pipeline. Nothing has been changed in HubSpot.',
  },
};

app.post('/rep-deals/action', async (req, res) => {
  const dealId = String(req.body?.dealId || '').trim();
  const action = String(req.body?.action || '').trim();
  const repName = String(req.body?.repName || '').trim();
  /*
   * `value` is a string for a note and an object for the adjuster form, so it is
   * kept raw here and read in the shape each branch expects.
   */
  const rawValue = req.body?.value;

  if (!dealId) return res.status(400).json({ success: false, error: 'A deal id is required.' });
  if (!['note', 'adjuster', 'lost', 'retail'].includes(action)) {
    return res.status(400).json({ success: false, error: `Unknown action "${action}".` });
  }

  /*
   * `lost` and `retail` ask ops to do something rather than doing it — they send
   * an email and stop. Handled here, ahead of the deal fetch below, so they make
   * no HubSpot call at all: there is no write for the pipeline guard to protect,
   * and a request about a deal this service may not touch is still a request ops
   * should see.
   */
  if (action === 'lost' || action === 'retail') {
    const request = DEAL_REQUESTS[action];
    const fields = (rawValue && typeof rawValue === 'object') ? rawValue : {};
    const customerName = String(fields.customerName || '').trim();
    const address = String(fields.address || '').trim();
    const currentStage = String(fields.currentStage || '').trim();

    if (!repName) {
      return res.status(400).json({ success: false, error: 'A rep name is required.' });
    }

    try {
      await resend.emails.send({
        from: 'NuHome Forms <noreply@thehiveoffice.com>',
        to: ['misty@thenuhome.com', 'mariah@thenuhome.com'],
        subject: `${request.subjectPrefix} — ${customerName || 'Unknown'}`,
        html: dealRequestEmailHtml({
          heading: request.heading,
          lead: request.lead,
          repName,
          customerName,
          address,
          currentStage,
          dealId,
        }),
      });
    } catch (err) {
      console.error(`[rep-deals] ${action} request email failed for deal`, dealId, err);
      return res.status(500).json({
        success: false,
        error: 'Could not notify ops — please try again or contact them directly.',
      });
    }

    console.log(`[rep-deals] ${action} request emailed to ops — deal`, dealId,
      JSON.stringify(customerName), 'at', stageLabel(currentStage), 'by', repName);
    return res.json({ success: true });
  }

  try {
    /*
     * The deal's own pipeline is read first and every decision below is made
     * against it — never against a pipeline supplied by the caller. This is what
     * keeps an Ops/Install deal unreachable no matter what is posted here.
     */
    const deal = await hubspot(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=pipeline,dealstage,dealname`);
    const pipeline = String(deal?.properties?.pipeline || '');
    const currentStage = String(deal?.properties?.dealstage || '');
    assertPipelineAllowed(pipeline);

    if (action === 'note') {
      const value = String(rawValue == null ? '' : rawValue).trim();
      if (!value) return res.status(400).json({ success: false, error: 'The note is empty.' });

      // Attributed in the body: notes created by a private app carry no author,
      // so without this ops cannot tell which rep left it.
      const body = repName ? `${value}\n\n— ${repName} (rep dashboard)` : value;

      await hubspot('/crm/v3/objects/notes', {
        method: 'POST',
        body: JSON.stringify({
          properties: { hs_timestamp: Date.now(), hs_note_body: body },
          associations: [{
            to: { id: dealId },
            types: [{
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: NOTE_TO_DEAL_ASSOCIATION_TYPE_ID,
            }],
          }],
        }),
      });

      console.log('[rep-deals] note posted to deal', dealId, 'by', repName || 'unknown rep');
      return res.json({ success: true });
    }

    // action === 'adjuster'
    const fields = (rawValue && typeof rawValue === 'object') ? rawValue : {};
    const properties = {};

    for (const key of ADJUSTER_TEXT_FIELDS) {
      const entry = String(fields[key] == null ? '' : fields[key]).trim();
      // Absent and empty are the same thing: leave whatever HubSpot already
      // holds rather than blanking a field the rep simply did not retype.
      if (entry) properties[key] = entry;
    }

    const meetingDate = String(fields.adjuster_meeting_date == null ? '' : fields.adjuster_meeting_date).trim();
    if (meetingDate) {
      if (!ISO_DATE_PATTERN.test(meetingDate)) {
        return res.status(400).json({ success: false, error: 'The meeting date must be in YYYY-MM-DD format.' });
      }
      properties.adjuster_meeting_date = meetingDate;
    }

    if (!Object.keys(properties).length) {
      return res.status(400).json({ success: false, error: 'Fill in at least one adjuster field.' });
    }

    /*
     * Logging the appointment is what moves the deal, and only from the one
     * stage where that transition makes sense. A deal already at Adjuster
     * Meeting or beyond keeps its stage and just takes the field update, so
     * correcting a phone number later cannot drag a deal backwards or forwards.
     */
    const advancing = !!meetingDate
      && pipeline === INSPECTION_PIPELINE
      && currentStage === CONTINGENCY_SIGNED_STAGE_ID;
    if (advancing) properties.dealstage = ADJUSTER_MEETING_STAGE_ID;

    // Re-asserted immediately before the write, so the guard sits on the same
    // side of every early return above it.
    assertPipelineAllowed(pipeline);
    await hubspot(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });

    console.log('[rep-deals] adjuster info saved on deal', dealId,
      '-', Object.keys(properties).join(', '),
      advancing ? `(advanced ${currentStage} -> ${ADJUSTER_MEETING_STAGE_ID})` : '(stage unchanged)',
      'by', repName || 'unknown rep');

    return res.json({
      success: true,
      dealstage: advancing ? ADJUSTER_MEETING_STAGE_ID : currentStage,
      advanced: advancing,
      adjusterName: properties.adjuster_name || null,
      adjusterPhone: properties.adjuster_phone || null,
      adjusterEmail: properties.adjuster_email || null,
      adjusterMeetingDate: properties.adjuster_meeting_date || null,
    });
  } catch (err) {
    console.error('[rep-deals] action failed:', action, 'deal', dealId, err);
    return res.status(500).json({ success: false, error: 'Could not update the deal in HubSpot.' });
  }
});

// ===========================================================================
// /admin-deals — every open roofing deal, for public/admin-dashboard.html
//
// The one authenticated route in this service. ADMIN_TOKEN must be set in
// Railway; while it is unset this refuses everything rather than falling open.
// ===========================================================================

/**
 * Constant-time string comparison, so a wrong token cannot be narrowed down by
 * timing the response. Length is compared first and does leak, which is the
 * standard trade — a token's length is not the secret.
 */
function tokensMatch(supplied, expected) {
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function adminAuthorised(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    // Refusing here is the whole point: an unset variable would otherwise make
    // `undefined === undefined` a valid credential and open the route to anyone.
    console.error('[admin-deals] ADMIN_TOKEN is not set — refusing every request.');
    return false;
  }
  return tokensMatch(req.get('x-admin-token'), expected);
}

/** Walks every page of open deals across both roofing pipelines. */
async function searchOpenRoofingDeals() {
  const filterGroups = [{
    filters: [
      { propertyName: 'pipeline', operator: 'IN', values: [INSPECTION_PIPELINE, RETAIL_PIPELINE] },
      { propertyName: 'dealstage', operator: 'NOT_IN', values: CLOSED_STAGE_IDS },
    ],
  }];

  const collected = [];
  let after;
  // 50 pages is 5,000 deals — well past both roofing pipelines combined, and a
  // bound so a cursor that never terminates cannot spin the request forever.
  for (let page = 0; page < 50; page += 1) {
    const search = await hubspot('/crm/v3/objects/deals/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups,
        properties: REP_DEAL_PROPERTIES,
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        limit: 100,
        ...(after ? { after } : {}),
      }),
    });
    collected.push(...(search?.results || []));
    after = search?.paging?.next?.after;
    if (!after) break;
  }
  return collected;
}

app.get('/admin-deals', async (req, res) => {
  if (!adminAuthorised(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const rows = await searchOpenRoofingDeals();

    const insurance = [];
    const retail = [];
    const summary = { insurance: {}, retail: {} };

    for (const row of rows) {
      const deal = mapDealRow(row);

      // Structurally guaranteed by the search filter; re-checked because this is
      // where deal data leaves the service.
      if (deal.pipeline !== INSPECTION_PIPELINE && deal.pipeline !== RETAIL_PIPELINE) continue;

      const isInsurance = deal.pipeline === INSPECTION_PIPELINE;
      (isInsurance ? insurance : retail).push(deal);

      const bucket = isInsurance ? summary.insurance : summary.retail;
      bucket[deal.dealstage] = (bucket[deal.dealstage] || 0) + 1;
    }

    console.log('[admin-deals] open deals — insurance:', insurance.length, 'retail:', retail.length);
    return res.json({ success: true, insurance, retail, summary });
  } catch (err) {
    console.error('[admin-deals] lookup failed:', err);
    return res.status(500).json({ success: false, error: 'Could not load deals from HubSpot.' });
  }
});

/*
 * Registered last, so it catches what the route handlers cannot: multer rejects
 * a file (bad type, over the size limit) in middleware, before any route runs,
 * so those errors would otherwise reach Express's default handler and come back
 * as an HTML page. The browser parses every response as JSON.
 */
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message || err);

  /*
   * A machine-readable code plus a sentence the rep can act on — multer's own
   * message is just "File too large", which names no file and no limit.
   *
   * Currently unreachable: limits.fileSize is not set, so multer never raises
   * LIMIT_FILE_SIZE. Kept so the branch is correct if a cap is reintroduced.
   */
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      success: false,
      error: 'FILE_TOO_LARGE',
      message: 'A file exceeded the maximum allowed size. Please remove large files and try again.',
    });
  }

  const status = err instanceof multer.MulterError ? 400 : (err.status || 500);
  res.status(status).json({ success: false, error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Contingency form API running on port ${PORT} ✓`);
});
