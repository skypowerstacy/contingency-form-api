const express = require('express');
const multer = require('multer');
const { Resend } = require('resend');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const resend = new Resend(process.env.RESEND_API_KEY);

// ---- Inspection endpoint constants ----------------------------------------
const HUBSPOT_API = 'https://api.hubapi.com';
const INSPECTION_PIPELINE = '2476304118';
const INSPECTION_STAGE = '4130205409'; // Site Inspection
const SUPABASE_PROJECT_REF = 'rfytaiowxtpmesqzoidz';
const PHOTO_BUCKET = 'inspections';

/*
 * Ops/Install. Sales deals live here and the Deals Dashboard reads from it —
 * nothing in this service may ever write to it. This is the same guard the
 * RepCard sync carries, for the same reason.
 */
const FORBIDDEN_PIPELINE = '1022523097';

/**
 * Throws unless the target pipeline is the inspection pipeline. Called before
 * every deal write rather than once at boot, so a future code path cannot
 * route around it by constructing its own payload.
 */
function assertPipelineAllowed(pipelineId) {
  const id = String(pipelineId);
  if (id === FORBIDDEN_PIPELINE) {
    throw new Error(
      `Refusing to write to pipeline ${FORBIDDEN_PIPELINE} (Ops/Install). This endpoint only writes to ${INSPECTION_PIPELINE}.`
    );
  }
  if (id !== INSPECTION_PIPELINE) {
    throw new Error(`Unexpected pipeline ${id}. This endpoint only writes to ${INSPECTION_PIPELINE}.`);
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
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

    // Strip any parameters ("image/jpeg; charset=…") and normalise case.
    const mimetype = String(file.mimetype || '').toLowerCase().split(';')[0].trim();

    if (allowed.includes(mimetype) || allowedExtension.test(file.originalname || '')) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, HEIC, and PDF files are accepted.'));
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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/submit', upload.array('files', 10), async (req, res) => {
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
      adjusterAppointment,
      submittedAt,
    } = req.body;
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'At least one file is required.' });
    }

    const required = [
      [repName, 'Rep name'],
      [customerName, 'Customer name'],
      [propertyAddress, 'Property address'],
      [insuranceCarrier, 'Insurance carrier'],
      [claimNumber, 'Claim number'],
      [adjusterName, 'Adjuster name'],
      [adjusterPhone, 'Adjuster phone'],
    ];

    for (const [value, label] of required) {
      if (!value || value.trim() === '') {
        return res.status(400).json({ error: `${label} is required.` });
      }
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

    const adjusterEmailDisplay = (adjusterEmail || '').trim() || 'Not provided';

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
    const appointment = (adjusterAppointment || '').trim();
    // datetime-local omits seconds unless they are non-zero.
    const appointmentUtc = appointment.length === 16 ? `${appointment}:00Z` : `${appointment}Z`;
    const parsedAppointment = appointment ? new Date(appointmentUtc) : null;
    const adjusterAppointmentDisplay = !appointment
      ? 'Not scheduled'
      : parsedAppointment && !isNaN(parsedAppointment.getTime())
        ? parsedAppointment.toLocaleString('en-US', {
            timeZone: 'UTC',
            dateStyle: 'full',
            timeStyle: 'short',
          })
        : appointment;

    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a1a2e; padding: 24px; border-radius: 8px 8px 0 0;">
          <h1 style="color: #f97316; margin: 0; font-size: 20px;">NuHome — Contingency Form Submission</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-radius: 0 0 8px 8px;">
          <p style="margin: 0 0 12px;"><strong>Customer:</strong> ${escapeHtml(customerName.trim())}</p>
          <p style="margin: 0 0 12px;"><strong>Property Address:</strong> ${escapeHtml(propertyAddress.trim())}</p>
          <p style="margin: 0 0 12px;"><strong>Insurance Carrier:</strong> ${escapeHtml(insuranceCarrier.trim())}</p>
          <p style="margin: 0 0 12px;"><strong>Claim Number:</strong> ${escapeHtml(claimNumber.trim())}</p>
          <p style="margin: 0 0 12px;"><strong>Adjuster Name:</strong> ${escapeHtml(adjusterName.trim())}</p>
          <p style="margin: 0 0 12px;"><strong>Adjuster Phone:</strong> ${escapeHtml(adjusterPhone.trim())}</p>
          <p style="margin: 0 0 12px;"><strong>Adjuster Email:</strong> ${escapeHtml(adjusterEmailDisplay)}</p>
          <p style="margin: 0 0 12px;"><strong>Adjuster Appointment:</strong> ${escapeHtml(adjusterAppointmentDisplay)}</p>
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

    res.json({ success: true });

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
async function resolveCloserOption(repName) {
  if (!repName) return null;
  const property = await hubspot('/crm/v3/properties/deals/closer');
  const options = property?.options || [];
  const target = normaliseName(repName);
  if (!target) return null;

  const exact = options.find(o => normaliseName(o.label) === target || normaliseName(o.value) === target);
  if (exact) return exact.value;

  const partial = options.find(o => {
    const label = normaliseName(o.label);
    return label && (label.includes(target) || target.includes(label));
  });
  return partial ? partial.value : null;
}

async function createInspectionDeal(fields, contactId) {
  assertPipelineAllowed(INSPECTION_PIPELINE);

  const { fname, lname, address, carrier, stormDate, squares, rep } = fields;
  const dealname = `${[fname, lname].filter(Boolean).join(' ') || 'Unknown homeowner'} - ${address || 'No address'}`;

  const properties = {
    dealname,
    pipeline: INSPECTION_PIPELINE,
    dealstage: INSPECTION_STAGE,
  };
  if (carrier) properties.insurance_company = carrier;
  if (stormDate) {
    properties.storm_date = stormDate;
    properties.date_of_loss = stormDate; // no separate field is collected today
  }
  if (squares) properties.number_of_squares = squares;

  let closerWarning = null;
  try {
    const closer = await resolveCloserOption(rep);
    if (closer) properties.closer = closer;
    else if (rep) closerWarning = `No "closer" option matched rep "${rep}" — property omitted.`;
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

  return { dealId: deal.id, closerWarning };
}

async function uploadPhotos(dealId, photos) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.');

  const supabase = createClient(url, key);
  const uploaded = [];
  const failed = [];

  for (const photo of photos) {
    const safeName = String(photo.originalname || 'photo.jpg').replace(/[^\w.\-]/g, '_');
    const path = `${dealId}/${photo.category}/${safeName}`;
    const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, photo.buffer, {
      contentType: photo.mimetype,
      upsert: true,
    });
    if (error) failed.push(`${path}: ${error.message}`);
    else uploaded.push(path);
  }

  return { uploaded, failed };
}

function inspectionEmailHtml(fields, damageReport, photosUrl, photoCount, notes) {
  const rows = [
    ['Property address', fields.address],
    ['Homeowner', [fields.fname, fields.lname].filter(Boolean).join(' ')],
    ['Phone', fields.phone],
    ['Email', fields.customer_email],
    ['Insurance carrier', fields.carrier],
    ['Inspector / rep', fields.rep],
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
  const notes = [];
  let dealId = null;
  let photosUrl = null;

  const FIELDS = [
    'address', 'fname', 'lname', 'phone', 'customer_email', 'carrier', 'rep',
    'stormDate', 'hailSize', 'pitch', 'stories', 'squares', 'roofAge',
    'severity', 'mortgage', 'recommendation', 'notes', 'inspectionDate',
  ];

  try {
    const fields = {};
    for (const key of FIELDS) fields[key] = (req.body?.[key] ?? '').toString().trim();
    const damageReport = (req.body?.damageReport ?? '').toString();

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
    } catch (err) {
      console.error('[inspection] deal creation failed:', err);
      notes.push('HubSpot deal was not created');
    }

    // ---- Supabase ----
    // Photos are keyed by deal id, so without one there is nowhere to put them.
    if (photos.length && dealId) {
      try {
        const { failed } = await uploadPhotos(dealId, photos);
        photosUrl = `https://${SUPABASE_PROJECT_REF}.supabase.co/storage/v1/object/public/${PHOTO_BUCKET}/${dealId}/`;
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

app.listen(PORT, () => {
  console.log(`Contingency form API running on port ${PORT} ✓`);
});
