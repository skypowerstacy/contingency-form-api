const express = require('express');
const multer = require('multer');
const { Resend } = require('resend');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const resend = new Resend(process.env.RESEND_API_KEY);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'image/heic', 'image/heif', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
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

app.listen(PORT, () => {
  console.log(`Contingency form API running on port ${PORT} ✓`);
});
