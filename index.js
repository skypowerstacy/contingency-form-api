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
    const { repName, customerName, submittedAt, adjusterMeetingDate } = req.body;
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'At least one file is required.' });
    }
    if (!repName || repName.trim() === '') {
      return res.status(400).json({ error: 'Rep name is required.' });
    }
    if (!customerName || customerName.trim() === '') {
      return res.status(400).json({ error: 'Customer name is required.' });
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

    // The form sends a date-only YYYY-MM-DD value, which Date parses as UTC
    // midnight — formatting that in America/Denver would render the day before.
    // Hence UTC here, unlike submittedDate above, which is a real instant.
    const meetingDate = (adjusterMeetingDate || '').trim();
    const parsedMeeting = meetingDate ? new Date(`${meetingDate}T00:00:00Z`) : null;
    const adjusterMeetingDisplay = !meetingDate
      ? 'Not provided'
      : parsedMeeting && !isNaN(parsedMeeting.getTime())
        ? parsedMeeting.toLocaleDateString('en-US', { timeZone: 'UTC', dateStyle: 'full' })
        : meetingDate;

    const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a1a2e; padding: 24px; border-radius: 8px 8px 0 0;">
          <h1 style="color: #f97316; margin: 0; font-size: 20px;">NuHome — Contingency Form Submission</h1>
        </div>
        <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-radius: 0 0 8px 8px;">
          <p style="margin: 0 0 12px;"><strong>Customer:</strong> ${escapeHtml(customerName.trim())}</p>
          <p style="margin: 0 0 12px;"><strong>Adjuster Meeting Date:</strong> ${escapeHtml(adjusterMeetingDisplay)}</p>
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
