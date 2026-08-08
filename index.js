<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Contingency Form Submission — NuHome</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0f0f1a;
      color: #f1f1f1;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    header {
      background: #0f0f1a;
      border-bottom: 2px solid #f97316;
      padding: 18px 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-mark {
      width: 36px;
      height: 36px;
      background: #f97316;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      font-size: 18px;
      color: #0f0f1a;
      letter-spacing: -1px;
      flex-shrink: 0;
    }

    header h1 {
      font-size: 15px;
      font-weight: 600;
      color: #f1f1f1;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    header span {
      font-size: 15px;
      font-weight: 400;
      color: #f97316;
    }

    main {
      flex: 1;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 40px 20px 60px;
    }

    .card {
      background: #1a1a2e;
      border: 1px solid #2a2a45;
      border-radius: 12px;
      padding: 36px;
      width: 100%;
      max-width: 520px;
    }

    .card-title {
      font-size: 22px;
      font-weight: 700;
      color: #f1f1f1;
      margin-bottom: 6px;
    }

    .card-sub {
      font-size: 14px;
      color: #9ca3af;
      margin-bottom: 32px;
      line-height: 1.5;
    }

    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #d1d5db;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 8px;
    }

    input[type="text"] {
      width: 100%;
      background: #0f0f1a;
      border: 1px solid #2a2a45;
      border-radius: 8px;
      padding: 12px 14px;
      color: #f1f1f1;
      font-size: 16px;
      outline: none;
      transition: border-color 0.2s;
      margin-bottom: 24px;
    }

    input[type="text"]:focus {
      border-color: #f97316;
    }

    input[type="text"]::placeholder {
      color: #4b5563;
    }

    .upload-zone {
      border: 2px dashed #2a2a45;
      border-radius: 10px;
      padding: 32px 20px;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
      margin-bottom: 16px;
      position: relative;
    }

    .upload-zone:hover, .upload-zone.dragover {
      border-color: #f97316;
      background: rgba(249, 115, 22, 0.05);
    }

    .upload-zone input[type="file"] {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
      width: 100%;
      height: 100%;
    }

    .upload-icon {
      font-size: 32px;
      margin-bottom: 10px;
    }

    .upload-zone p {
      font-size: 14px;
      color: #9ca3af;
      line-height: 1.5;
    }

    .upload-zone strong {
      color: #f97316;
    }

    .file-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 28px;
    }

    .file-item {
      display: flex;
      align-items: center;
      gap: 10px;
      background: #0f0f1a;
      border: 1px solid #2a2a45;
      border-radius: 8px;
      padding: 10px 14px;
    }

    .file-item-icon {
      font-size: 18px;
      flex-shrink: 0;
    }

    .file-item-name {
      flex: 1;
      font-size: 13px;
      color: #d1d5db;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .file-item-size {
      font-size: 12px;
      color: #6b7280;
      flex-shrink: 0;
    }

    .file-remove {
      background: none;
      border: none;
      color: #6b7280;
      cursor: pointer;
      font-size: 16px;
      padding: 2px 4px;
      border-radius: 4px;
      flex-shrink: 0;
      transition: color 0.2s;
    }

    .file-remove:hover {
      color: #ef4444;
    }

    .hint {
      font-size: 12px;
      color: #6b7280;
      margin-bottom: 28px;
      line-height: 1.5;
    }

    .btn-submit {
      width: 100%;
      background: #f97316;
      color: #0f0f1a;
      border: none;
      border-radius: 8px;
      padding: 14px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      letter-spacing: 0.03em;
      transition: background 0.2s, opacity 0.2s;
    }

    .btn-submit:hover:not(:disabled) {
      background: #ea6c0a;
    }

    .btn-submit:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Error */
    .error-banner {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid #ef4444;
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 13px;
      color: #fca5a5;
      margin-bottom: 20px;
      display: none;
    }

    /* Loading state */
    .loading-state {
      text-align: center;
      padding: 20px 0;
      display: none;
    }

    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #2a2a45;
      border-top-color: #f97316;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 16px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .loading-state p {
      color: #9ca3af;
      font-size: 14px;
    }

    /* Success screen */
    #success-screen {
      display: none;
      text-align: center;
      padding: 20px 0;
    }

    .success-icon {
      width: 64px;
      height: 64px;
      background: rgba(34, 197, 94, 0.15);
      border: 2px solid #22c55e;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      margin: 0 auto 20px;
    }

    #success-screen h2 {
      font-size: 22px;
      font-weight: 700;
      color: #f1f1f1;
      margin-bottom: 10px;
    }

    #success-screen p {
      font-size: 14px;
      color: #9ca3af;
      line-height: 1.6;
      margin-bottom: 28px;
    }

    .btn-reset {
      background: transparent;
      border: 1px solid #2a2a45;
      border-radius: 8px;
      padding: 12px 24px;
      font-size: 14px;
      color: #d1d5db;
      cursor: pointer;
      transition: border-color 0.2s, color 0.2s;
    }

    .btn-reset:hover {
      border-color: #f97316;
      color: #f97316;
    }

    @media (max-width: 560px) {
      .card { padding: 24px 20px; }
      .card-title { font-size: 19px; }
    }
  </style>
</head>
<body>

  <header>
    <div class="logo-mark">N</div>
    <h1>NuHome &nbsp;<span>/ Contingency Form Submission</span></h1>
  </header>

  <main>
    <div class="card">

      <!-- Form -->
      <div id="form-screen">
        <p class="card-title">Submit Contingency Form</p>
        <p class="card-sub">Upload the signed paper form — one page or multiple photos. It goes straight to the office.</p>

        <div class="error-banner" id="error-banner"></div>

        <label for="rep-name">Your Name</label>
        <input type="text" id="rep-name" placeholder="First and last name" autocomplete="name" />

        <label for="customer-name">Customer Name</label>
        <input type="text" id="customer-name" placeholder="Homeowner first and last name" autocomplete="off" />

        <label>Form Pages</label>
        <div class="upload-zone" id="upload-zone">
          <input type="file" id="file-input" accept=".jpg,.jpeg,.png,.pdf,.heic,.heif" multiple />
          <div class="upload-icon">📎</div>
          <p><strong>Tap to upload</strong> or drag files here<br/>JPG, PNG, HEIC, or PDF · Up to 15 MB each</p>
        </div>

        <div class="file-list" id="file-list"></div>

        <p class="hint">Take a clear photo of each page. Make sure the signature is visible.</p>

        <div class="loading-state" id="loading-state">
          <div class="spinner"></div>
          <p>Sending to the office…</p>
        </div>

        <button class="btn-submit" id="submit-btn" onclick="handleSubmit()">Send Form</button>
      </div>

      <!-- Success -->
      <div id="success-screen">
        <div class="success-icon">✓</div>
        <h2>Form Sent!</h2>
        <p>The contingency form has been delivered to Misty and Mariah. You're all set.</p>
        <button class="btn-reset" onclick="resetForm()">Submit Another</button>
      </div>

    </div>
  </main>

  <script>
    // ⚠️ UPDATE THIS after Railway deploy
    const API_URL = 'https://contingency-form-api-production.up.railway.app/submit';

    const fileInput = document.getElementById('file-input');
    const fileList = document.getElementById('file-list');
    const uploadZone = document.getElementById('upload-zone');
    let selectedFiles = [];

    fileInput.addEventListener('change', () => addFiles(fileInput.files));

    uploadZone.addEventListener('dragover', e => {
      e.preventDefault();
      uploadZone.classList.add('dragover');
    });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', e => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
      addFiles(e.dataTransfer.files);
    });

    function addFiles(newFiles) {
      for (const f of newFiles) {
        if (!selectedFiles.find(x => x.name === f.name && x.size === f.size)) {
          selectedFiles.push(f);
        }
      }
      renderFileList();
    }

    function removeFile(index) {
      selectedFiles.splice(index, 1);
      renderFileList();
    }

    function renderFileList() {
      fileList.innerHTML = '';
      selectedFiles.forEach((f, i) => {
        const icon = f.type === 'application/pdf' ? '📄' : '🖼️';
        const size = f.size > 1024 * 1024
          ? (f.size / 1024 / 1024).toFixed(1) + ' MB'
          : (f.size / 1024).toFixed(0) + ' KB';

        const el = document.createElement('div');
        el.className = 'file-item';
        el.innerHTML = `
          <span class="file-item-icon">${icon}</span>
          <span class="file-item-name">${f.name}</span>
          <span class="file-item-size">${size}</span>
          <button class="file-remove" onclick="removeFile(${i})" title="Remove">✕</button>
        `;
        fileList.appendChild(el);
      });
    }

    function showError(msg) {
      const banner = document.getElementById('error-banner');
      banner.textContent = msg;
      banner.style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function hideError() {
      document.getElementById('error-banner').style.display = 'none';
    }

    async function handleSubmit() {
      hideError();

      const repName = document.getElementById('rep-name').value.trim();
      const customerName = document.getElementById('customer-name').value.trim();
      if (!repName) { showError('Please enter your name before submitting.'); return; }
      if (!customerName) { showError('Please enter the customer name before submitting.'); return; }
      if (selectedFiles.length === 0) { showError('Please upload at least one photo or PDF of the form.'); return; }

      const btn = document.getElementById('submit-btn');
      const loader = document.getElementById('loading-state');

      btn.disabled = true;
      btn.style.display = 'none';
      loader.style.display = 'block';

      try {
        const formData = new FormData();
        formData.append('repName', repName);
        formData.append('customerName', customerName);
        formData.append('submittedAt', new Date().toISOString());
        selectedFiles.forEach(f => formData.append('files', f));

        const res = await fetch(API_URL, { method: 'POST', body: formData });
        const data = await res.json();

        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Something went wrong. Please try again.');
        }

        document.getElementById('form-screen').style.display = 'none';
        document.getElementById('success-screen').style.display = 'block';

      } catch (err) {
        loader.style.display = 'none';
        btn.style.display = 'block';
        btn.disabled = false;
        showError(err.message || 'Submission failed. Check your connection and try again.');
      }
    }

    function resetForm() {
      selectedFiles = [];
      renderFileList();
      document.getElementById('rep-name').value = '';
      document.getElementById('customer-name').value = '';
      document.getElementById('success-screen').style.display = 'none';
      document.getElementById('form-screen').style.display = 'block';
      hideError();
    }
  </script>

</body>
</html>