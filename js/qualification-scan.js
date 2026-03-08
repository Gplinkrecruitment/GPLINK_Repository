(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var MODAL_ID = 'gp-qual-scan-modal';
  var STYLE_ID = 'gp-qual-scan-style';

  var DOC_LABELS = {
    primary_medical_degree: 'Primary Medical Degree',
    mrcgp_certified: 'MRCGP Certificate',
    cct_certified: 'CCT Certificate',
    cv_signed_dated: 'Signed CV',
    certificate_good_standing: 'Certificate of Good Standing',
    confirmation_training: 'Confirmation of Training',
    criminal_history: 'Criminal History Check'
  };

  var DOC_DESCRIPTIONS = {
    primary_medical_degree: 'Certified copy of your MBBS / MBChB degree',
    mrcgp_certified: 'Membership of the Royal College of General Practitioners',
    cct_certified: 'Certificate of Completion of Training in General Practice',
    cv_signed_dated: 'Your up-to-date curriculum vitae, signed and dated',
    certificate_good_standing: 'Certificate of Good Standing from GMC (CCPS)',
    confirmation_training: 'Confirmation of specialist training from GMC Portfolio',
    criminal_history: 'Criminal history or police clearance check (e.g. Fit2Work)'
  };

  var DOC_ICONS = {
    primary_medical_degree: '<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c0 2.5 3.5 4 6 4s6-1.5 6-4v-5"/>',
    mrcgp_certified: '<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11"/>',
    cct_certified: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15l2 2 4-4"/>',
    cv_signed_dated: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/><path d="M8 9h2"/>',
    certificate_good_standing: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    confirmation_training: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 10l2 2 4-4"/>',
    criminal_history: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5 5"/><circle cx="15" cy="13" r="4"/><path d="M15 3h4a2 2 0 0 1 2 2v4"/>'
  };

  function scanIconSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7V5a1 1 0 0 1 1-1h2"></path><path d="M20 7V5a1 1 0 0 0-1-1h-2"></path><path d="M4 17v2a1 1 0 0 0 1 1h2"></path><path d="M20 17v2a1 1 0 0 1-1 1h-2"></path><path d="M8 12h8"></path><path d="M12 8v8"></path></svg>';
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      /* Nav button styles */
      '.gp-qual-scan-desktop{border:1px solid rgba(191,220,255,.95)!important;border-radius:12px!important;background:rgba(255,255,255,.6)!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.88),0 10px 16px -14px rgba(37,99,235,.45)!important;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);}',
      '.gp-qual-scan-mobile-icon{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:999px;background:linear-gradient(180deg,#3b82f6 0%,#1d4ed8 100%);color:#fff;box-shadow:0 10px 20px -14px rgba(29,78,216,.95);}',
      '.gp-qual-scan-mobile-icon svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
      '.gp-qual-scan-mobile-tab{position:relative;z-index:3;}',
      '.gp-qual-scan-mobile-tab .bottom-tab-label,.gp-qual-scan-mobile-tab .mobile-tab-label{font-weight:760;}',

      /* Backdrop */
      '.gp-scan-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.3);backdrop-filter:blur(0);-webkit-backdrop-filter:blur(0);display:flex;align-items:flex-end;justify-content:center;z-index:1300;opacity:0;pointer-events:none;transition:opacity .25s ease,backdrop-filter .25s ease,-webkit-backdrop-filter .25s ease;}',
      '.gp-scan-backdrop.show{opacity:1;pointer-events:auto;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);}',

      /* Modal container - slides up like a sheet */
      '.gp-scan-sheet{width:100%;max-width:520px;max-height:92vh;border-radius:20px 20px 0 0;background:#fff;box-shadow:0 -8px 40px -12px rgba(15,23,42,.25);display:flex;flex-direction:column;transform:translateY(100%);transition:transform .4s cubic-bezier(.22,.9,.18,1.02);}',
      '.gp-scan-backdrop.show .gp-scan-sheet{transform:translateY(0);}',

      /* Handle bar */
      '.gp-scan-handle{display:flex;justify-content:center;padding:10px 0 4px;}',
      '.gp-scan-handle-bar{width:36px;height:4px;border-radius:999px;background:#d1d5db;}',

      /* Header */
      '.gp-scan-header{display:flex;align-items:center;justify-content:space-between;padding:4px 20px 14px;border-bottom:1px solid #f1f5f9;}',
      '.gp-scan-header-left{display:flex;align-items:center;gap:10px;}',
      '.gp-scan-header-icon{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#2563eb,#1d4ed8);display:grid;place-items:center;color:#fff;flex-shrink:0;}',
      '.gp-scan-header-icon svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
      '.gp-scan-header h3{margin:0;font-size:17px;font-weight:800;color:#0f172a;letter-spacing:-.01em;}',
      '.gp-scan-close{border:0;background:transparent;color:#94a3b8;width:32px;height:32px;border-radius:8px;cursor:pointer;display:grid;place-items:center;transition:all .15s ease;font-size:20px;font-weight:600;}',
      '.gp-scan-close:hover{background:#f1f5f9;color:#334155;}',

      /* Body */
      '.gp-scan-body{flex:1;overflow-y:auto;padding:20px;display:grid;gap:16px;}',

      /* Steps container */
      '.gp-scan-step{display:none;gap:16px;}',
      '.gp-scan-step.active{display:grid;}',

      /* ── STEP 1: Upload ── */
      '.gp-scan-dropzone{border:2px dashed #d1d5db;border-radius:16px;padding:32px 20px;display:grid;justify-items:center;gap:12px;text-align:center;cursor:pointer;transition:all .2s ease;background:#fafbfc;}',
      '.gp-scan-dropzone:hover,.gp-scan-dropzone.drag-over{border-color:#2563eb;background:#eff6ff;}',
      '.gp-scan-dropzone-icon{width:56px;height:56px;border-radius:14px;background:#eff6ff;display:grid;place-items:center;color:#2563eb;}',
      '.gp-scan-dropzone-icon svg{width:28px;height:28px;stroke:currentColor;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;}',
      '.gp-scan-dropzone h4{margin:0;font-size:15px;font-weight:700;color:#0f172a;}',
      '.gp-scan-dropzone p{margin:0;font-size:12px;color:#64748b;font-weight:500;line-height:1.4;}',
      '.gp-scan-dropzone .browse-link{color:#2563eb;font-weight:700;text-decoration:underline;cursor:pointer;}',

      /* File preview card */
      '.gp-scan-file-card{border:1px solid #e2e8f0;border-radius:12px;padding:12px;display:none;align-items:center;gap:12px;background:#f8fafc;}',
      '.gp-scan-file-card.show{display:flex;}',
      '.gp-scan-file-icon{width:40px;height:40px;border-radius:8px;background:#dbeafe;display:grid;place-items:center;color:#2563eb;flex-shrink:0;}',
      '.gp-scan-file-icon svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
      '.gp-scan-file-info{min-width:0;flex:1;}',
      '.gp-scan-file-name{font-size:13px;font-weight:700;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.gp-scan-file-size{font-size:11px;color:#64748b;font-weight:500;}',
      '.gp-scan-file-remove{border:0;background:transparent;color:#94a3b8;cursor:pointer;padding:4px;border-radius:6px;display:grid;place-items:center;transition:all .15s;}',
      '.gp-scan-file-remove:hover{background:#fef2f2;color:#dc2626;}',
      '.gp-scan-file-remove svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',

      /* Text hint */
      '.gp-scan-text-toggle{border:0;background:transparent;color:#2563eb;font-size:12px;font-weight:600;cursor:pointer;padding:0;text-decoration:underline;}',
      '.gp-scan-text-area{display:none;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;font:inherit;font-size:13px;color:#0f172a;background:#fff;min-height:72px;resize:vertical;width:100%;transition:border-color .2s;}',
      '.gp-scan-text-area:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1);}',
      '.gp-scan-text-area.show{display:block;}',

      /* Scan button */
      '.gp-scan-submit{width:100%;border:0;border-radius:12px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;font:inherit;font-size:14px;font-weight:700;padding:14px;cursor:pointer;transition:all .15s;box-shadow:0 4px 12px -4px rgba(37,99,235,.4);}',
      '.gp-scan-submit:hover{background:linear-gradient(135deg,#1d4ed8,#1e40af);}',
      '.gp-scan-submit:disabled{opacity:.5;cursor:not-allowed;}',

      /* ── STEP 2: Scanning ── */
      '.gp-scan-progress{display:grid;justify-items:center;gap:20px;padding:20px 0;}',

      /* Scan animation ring */
      '.gp-scan-ring{width:120px;height:120px;position:relative;}',
      '.gp-scan-ring-svg{width:100%;height:100%;transform:rotate(-90deg);}',
      '.gp-scan-ring-bg{fill:none;stroke:#e2e8f0;stroke-width:6;}',
      '.gp-scan-ring-fill{fill:none;stroke:#2563eb;stroke-width:6;stroke-linecap:round;stroke-dasharray:339.292;stroke-dashoffset:339.292;transition:stroke-dashoffset .6s ease;}',
      '.gp-scan-ring-icon{position:absolute;inset:0;display:grid;place-items:center;}',
      '.gp-scan-ring-icon svg{width:36px;height:36px;stroke:#2563eb;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;}',

      /* Scan pulse */
      '.gp-scan-ring-pulse{position:absolute;inset:-8px;border-radius:50%;border:2px solid rgba(37,99,235,.15);animation:scanPulse 2s ease-in-out infinite;}',
      '@keyframes scanPulse{0%,100%{transform:scale(.95);opacity:.6;}50%{transform:scale(1.05);opacity:0;}}',

      /* Phase labels */
      '.gp-scan-phase-title{font-size:16px;font-weight:800;color:#0f172a;text-align:center;}',
      '.gp-scan-phase-desc{font-size:13px;color:#64748b;font-weight:500;text-align:center;line-height:1.5;max-width:320px;}',

      /* Phase steps list */
      '.gp-scan-phases{display:grid;gap:8px;width:100%;max-width:320px;}',
      '.gp-scan-phase-row{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;transition:all .3s ease;}',
      '.gp-scan-phase-row.active{background:#eff6ff;}',
      '.gp-scan-phase-row.done{background:#ecfdf5;}',
      '.gp-scan-phase-dot{width:24px;height:24px;border-radius:50%;border:2px solid #d1d5db;display:grid;place-items:center;flex-shrink:0;transition:all .3s ease;font-size:12px;color:transparent;}',
      '.gp-scan-phase-row.active .gp-scan-phase-dot{border-color:#2563eb;background:#2563eb;color:#fff;animation:dotPulse 1.2s ease infinite;}',
      '.gp-scan-phase-row.done .gp-scan-phase-dot{border-color:#16a34a;background:#16a34a;color:#fff;}',
      '@keyframes dotPulse{0%,100%{box-shadow:0 0 0 0 rgba(37,99,235,.3);}50%{box-shadow:0 0 0 6px rgba(37,99,235,0);}}',
      '.gp-scan-phase-text{font-size:13px;font-weight:600;color:#94a3b8;transition:color .3s;}',
      '.gp-scan-phase-row.active .gp-scan-phase-text{color:#1d4ed8;font-weight:700;}',
      '.gp-scan-phase-row.done .gp-scan-phase-text{color:#166534;font-weight:700;}',

      /* ── STEP 3: Result ── */
      '.gp-scan-result{display:grid;gap:16px;}',
      '.gp-scan-result-banner{border-radius:16px;padding:24px 20px;display:grid;justify-items:center;gap:10px;text-align:center;}',
      '.gp-scan-result-banner.success{background:linear-gradient(135deg,#ecfdf5 0%,#f0fdf4 100%);border:1px solid #bbf7d0;}',
      '.gp-scan-result-banner.error{background:linear-gradient(135deg,#fef2f2 0%,#fff5f5 100%);border:1px solid #fecaca;}',
      '.gp-scan-result-check{width:56px;height:56px;border-radius:50%;display:grid;place-items:center;}',
      '.gp-scan-result-banner.success .gp-scan-result-check{background:#dcfce7;color:#16a34a;}',
      '.gp-scan-result-banner.error .gp-scan-result-check{background:#fecaca;color:#dc2626;}',
      '.gp-scan-result-check svg{width:28px;height:28px;stroke:currentColor;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;}',
      '.gp-scan-result-title{margin:0;font-size:18px;font-weight:800;color:#0f172a;}',
      '.gp-scan-result-desc{margin:0;font-size:13px;color:#64748b;font-weight:500;line-height:1.5;}',

      /* Classification card */
      '.gp-scan-class-card{border:1px solid #e2e8f0;border-radius:14px;padding:16px;display:grid;gap:12px;}',
      '.gp-scan-class-top{display:flex;align-items:center;gap:12px;}',
      '.gp-scan-class-icon{width:44px;height:44px;border-radius:10px;background:#eff6ff;display:grid;place-items:center;color:#2563eb;flex-shrink:0;}',
      '.gp-scan-class-icon svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
      '.gp-scan-class-info{min-width:0;}',
      '.gp-scan-class-label{font-size:15px;font-weight:800;color:#0f172a;margin:0;}',
      '.gp-scan-class-sublabel{font-size:12px;color:#64748b;font-weight:500;margin:0;line-height:1.4;}',

      /* Confidence bar */
      '.gp-scan-conf{display:grid;gap:4px;}',
      '.gp-scan-conf-header{display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:700;}',
      '.gp-scan-conf-label{color:#64748b;}',
      '.gp-scan-conf-value{color:#0f172a;}',
      '.gp-scan-conf-track{height:6px;border-radius:999px;background:#e2e8f0;overflow:hidden;}',
      '.gp-scan-conf-fill{height:100%;border-radius:999px;transition:width .6s ease;}',
      '.gp-scan-conf-fill.high{background:linear-gradient(90deg,#16a34a,#22c55e);}',
      '.gp-scan-conf-fill.medium{background:linear-gradient(90deg,#f59e0b,#fbbf24);}',
      '.gp-scan-conf-fill.low{background:linear-gradient(90deg,#dc2626,#ef4444);}',

      /* Reason text */
      '.gp-scan-reason{font-size:12px;color:#475569;font-weight:500;line-height:1.5;padding:10px 12px;background:#f8fafc;border-radius:8px;border:1px solid #f1f5f9;}',

      /* Result actions */
      '.gp-scan-result-actions{display:grid;gap:8px;}',
      '.gp-scan-btn-confirm{width:100%;border:0;border-radius:12px;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;font:inherit;font-size:14px;font-weight:700;padding:14px;cursor:pointer;transition:all .15s;box-shadow:0 4px 12px -4px rgba(22,163,74,.4);}',
      '.gp-scan-btn-confirm:hover{background:linear-gradient(135deg,#15803d,#166534);}',
      '.gp-scan-btn-retry{width:100%;border:1px solid #e2e8f0;border-radius:12px;background:#fff;color:#0f172a;font:inherit;font-size:13px;font-weight:600;padding:12px;cursor:pointer;transition:all .15s;}',
      '.gp-scan-btn-retry:hover{background:#f8fafc;border-color:#cbd5e1;}',

      /* Filed tag */
      '.gp-scan-filed-tag{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:#ecfdf5;border:1px solid #bbf7d0;font-size:12px;font-weight:700;color:#166534;}',
      '.gp-scan-filed-tag svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;}',

      /* Desktop override - center the sheet */
      '@media(min-width:640px){',
      '  .gp-scan-backdrop{align-items:center;}',
      '  .gp-scan-sheet{border-radius:20px;max-height:85vh;transform:translateY(30px) scale(.96);opacity:0;transition:transform .35s cubic-bezier(.22,.9,.18,1.02),opacity .3s ease;}',
      '  .gp-scan-backdrop.show .gp-scan-sheet{transform:translateY(0) scale(1);opacity:1;}',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function getDocumentsState() {
    try {
      var raw = localStorage.getItem('gp_documents_prep');
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && parsed.docs && typeof parsed.docs === 'object') return parsed;
    } catch (err) {}
    return { country: 'uk', docs: {} };
  }

  function saveDocumentsState(state) {
    try {
      localStorage.setItem('gp_documents_prep', JSON.stringify(state));
    } catch (err) {}
    if (window.gpLinkStateSync && typeof window.gpLinkStateSync.push === 'function') {
      window.gpLinkStateSync.push();
    }
    window.dispatchEvent(new CustomEvent('gp-documents-updated', { detail: { source: 'qualification-scan' } }));
  }

  function readTextSnippet(file) {
    return new Promise(function (resolve) {
      if (!file) return resolve('');
      var type = String(file.type || '').toLowerCase();
      var name = String(file.name || '').toLowerCase();
      var textLike = type.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.csv') || name.endsWith('.md') || name.endsWith('.json');
      if (!textLike) return resolve('');
      var reader = new FileReader();
      reader.onload = function () {
        var text = typeof reader.result === 'string' ? reader.result : '';
        resolve(text.slice(0, 8000));
      };
      reader.onerror = function () { resolve(''); };
      reader.readAsText(file);
    });
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes < 1) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  /* ─── Modal ─── */
  var selectedFile = null;

  function ensureModal() {
    var existing = document.getElementById(MODAL_ID);
    if (existing) return existing;

    var backdrop = document.createElement('div');
    backdrop.id = MODAL_ID;
    backdrop.className = 'gp-scan-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.innerHTML = [
      '<div class="gp-scan-sheet" role="dialog" aria-modal="true" aria-labelledby="gpScanTitle">',
      '  <div class="gp-scan-handle"><div class="gp-scan-handle-bar"></div></div>',
      '  <div class="gp-scan-header">',
      '    <div class="gp-scan-header-left">',
      '      <div class="gp-scan-header-icon">' + scanIconSvg() + '</div>',
      '      <h3 id="gpScanTitle">Scan Document</h3>',
      '    </div>',
      '    <button class="gp-scan-close" type="button" data-scan-close aria-label="Close">&times;</button>',
      '  </div>',
      '  <div class="gp-scan-body">',

      /* Step 1: Upload */
      '    <div class="gp-scan-step active" data-scan-step="upload">',
      '      <div class="gp-scan-dropzone" id="gpScanDropzone">',
      '        <div class="gp-scan-dropzone-icon"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>',
      '        <h4>Drop your document here</h4>',
      '        <p>or <span class="browse-link">browse files</span></p>',
      '        <p>PDF, images, Word docs up to 10 MB</p>',
      '      </div>',
      '      <input id="gpScanFileInput" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.doc,.docx" hidden />',
      '      <div class="gp-scan-file-card" id="gpScanFileCard">',
      '        <div class="gp-scan-file-icon"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></div>',
      '        <div class="gp-scan-file-info">',
      '          <div class="gp-scan-file-name" id="gpScanFileName"></div>',
      '          <div class="gp-scan-file-size" id="gpScanFileSize"></div>',
      '        </div>',
      '        <button class="gp-scan-file-remove" type="button" id="gpScanFileRemove" aria-label="Remove file"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>',
      '      </div>',
      '      <button class="gp-scan-text-toggle" type="button" id="gpScanTextToggle">+ Add text from document (improves accuracy)</button>',
      '      <textarea class="gp-scan-text-area" id="gpScanText" placeholder="Paste any visible text from the certificate..."></textarea>',
      '      <button class="gp-scan-submit" type="button" id="gpScanSubmit" disabled>Scan with AI</button>',
      '    </div>',

      /* Step 2: Scanning */
      '    <div class="gp-scan-step" data-scan-step="scanning">',
      '      <div class="gp-scan-progress">',
      '        <div class="gp-scan-ring">',
      '          <div class="gp-scan-ring-pulse"></div>',
      '          <svg class="gp-scan-ring-svg" viewBox="0 0 120 120"><circle class="gp-scan-ring-bg" cx="60" cy="60" r="54"/><circle class="gp-scan-ring-fill" id="gpScanRingFill" cx="60" cy="60" r="54"/></svg>',
      '          <div class="gp-scan-ring-icon"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15l3-3 3 3"/></svg></div>',
      '        </div>',
      '        <h4 class="gp-scan-phase-title" id="gpScanPhaseTitle">Uploading document...</h4>',
      '        <p class="gp-scan-phase-desc" id="gpScanPhaseDesc">Preparing your document for AI analysis</p>',
      '        <div class="gp-scan-phases">',
      '          <div class="gp-scan-phase-row active" data-phase="upload">',
      '            <div class="gp-scan-phase-dot"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>',
      '            <span class="gp-scan-phase-text">Uploading document</span>',
      '          </div>',
      '          <div class="gp-scan-phase-row" data-phase="analyze">',
      '            <div class="gp-scan-phase-dot"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>',
      '            <span class="gp-scan-phase-text">Analyzing content</span>',
      '          </div>',
      '          <div class="gp-scan-phase-row" data-phase="classify">',
      '            <div class="gp-scan-phase-dot"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>',
      '            <span class="gp-scan-phase-text">Classifying qualification</span>',
      '          </div>',
      '          <div class="gp-scan-phase-row" data-phase="file">',
      '            <div class="gp-scan-phase-dot"><svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>',
      '            <span class="gp-scan-phase-text">Filing to documents</span>',
      '          </div>',
      '        </div>',
      '      </div>',
      '    </div>',

      /* Step 3: Result */
      '    <div class="gp-scan-step" data-scan-step="result">',
      '      <div class="gp-scan-result" id="gpScanResultContent"></div>',
      '    </div>',

      '  </div>',
      '</div>'
    ].join('\n');
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function resetModal() {
    selectedFile = null;
    var fileInput = document.getElementById('gpScanFileInput');
    var fileCard = document.getElementById('gpScanFileCard');
    var dropzone = document.getElementById('gpScanDropzone');
    var textArea = document.getElementById('gpScanText');
    var textToggle = document.getElementById('gpScanTextToggle');
    var submitBtn = document.getElementById('gpScanSubmit');
    var resultEl = document.getElementById('gpScanResultContent');

    if (fileInput) fileInput.value = '';
    if (fileCard) fileCard.classList.remove('show');
    if (dropzone) dropzone.style.display = '';
    if (textArea) { textArea.value = ''; textArea.classList.remove('show'); }
    if (textToggle) textToggle.style.display = '';
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Scan with AI'; }
    if (resultEl) resultEl.innerHTML = '';

    showStep('upload');
    resetPhases();
  }

  function showStep(name) {
    var modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    var steps = modal.querySelectorAll('[data-scan-step]');
    for (var i = 0; i < steps.length; i++) {
      steps[i].classList.toggle('active', steps[i].getAttribute('data-scan-step') === name);
    }
  }

  function openModal() {
    var modal = ensureModal();
    resetModal();
    modal.setAttribute('aria-hidden', 'false');
    // Trigger reflow before adding show class for animation
    void modal.offsetWidth;
    modal.classList.add('show');
  }

  function closeModal() {
    var modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }

  /* ─── File selection ─── */
  function setSelectedFile(file) {
    selectedFile = file;
    var fileCard = document.getElementById('gpScanFileCard');
    var dropzone = document.getElementById('gpScanDropzone');
    var fileName = document.getElementById('gpScanFileName');
    var fileSize = document.getElementById('gpScanFileSize');
    var submitBtn = document.getElementById('gpScanSubmit');

    if (file) {
      if (fileName) fileName.textContent = file.name;
      if (fileSize) fileSize.textContent = formatFileSize(file.size);
      if (fileCard) fileCard.classList.add('show');
      if (dropzone) dropzone.style.display = 'none';
      if (submitBtn) submitBtn.disabled = false;
    } else {
      if (fileCard) fileCard.classList.remove('show');
      if (dropzone) dropzone.style.display = '';
      if (submitBtn) submitBtn.disabled = true;
    }
  }

  /* ─── Scanning phases animation ─── */
  var phaseOrder = ['upload', 'analyze', 'classify', 'file'];
  var ringCircumference = 2 * Math.PI * 54; // ~339.29

  function resetPhases() {
    var modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    var rows = modal.querySelectorAll('.gp-scan-phase-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.remove('active', 'done');
    }
    var ringFill = document.getElementById('gpScanRingFill');
    if (ringFill) ringFill.style.strokeDashoffset = ringCircumference;
  }

  function setPhase(phaseIndex) {
    var modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    var rows = modal.querySelectorAll('.gp-scan-phase-row');
    var titles = ['Uploading document...', 'Analyzing content...', 'Classifying qualification...', 'Filing to your documents...'];
    var descs = [
      'Preparing your document for AI analysis',
      'Our AI is reading and extracting key information',
      'Matching against known qualification types',
      'Saving to the correct document category'
    ];

    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.remove('active', 'done');
      if (i < phaseIndex) rows[i].classList.add('done');
      else if (i === phaseIndex) rows[i].classList.add('active');
    }

    var titleEl = document.getElementById('gpScanPhaseTitle');
    var descEl = document.getElementById('gpScanPhaseDesc');
    if (titleEl && titles[phaseIndex]) titleEl.textContent = titles[phaseIndex];
    if (descEl && descs[phaseIndex]) descEl.textContent = descs[phaseIndex];

    // Update ring progress
    var progress = (phaseIndex + 0.5) / phaseOrder.length;
    var ringFill = document.getElementById('gpScanRingFill');
    if (ringFill) {
      ringFill.style.strokeDashoffset = ringCircumference * (1 - progress);
    }
  }

  function completeAllPhases() {
    var modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    var rows = modal.querySelectorAll('.gp-scan-phase-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.remove('active');
      rows[i].classList.add('done');
    }
    var titleEl = document.getElementById('gpScanPhaseTitle');
    var descEl = document.getElementById('gpScanPhaseDesc');
    if (titleEl) titleEl.textContent = 'Scan complete!';
    if (descEl) descEl.textContent = 'Your document has been identified and filed';
    var ringFill = document.getElementById('gpScanRingFill');
    if (ringFill) ringFill.style.strokeDashoffset = 0;
  }

  /* ─── Result rendering ─── */
  function renderSuccessResult(classification, fileName) {
    var key = classification.key || '';
    var label = DOC_LABELS[key] || classification.label || key;
    var desc = DOC_DESCRIPTIONS[key] || '';
    var confidence = typeof classification.confidence === 'number' ? Math.round(classification.confidence * 100) : null;
    var reason = classification.reason || '';
    var iconPath = DOC_ICONS[key] || DOC_ICONS.primary_medical_degree;
    var confClass = confidence >= 75 ? 'high' : confidence >= 50 ? 'medium' : 'low';

    var html = [
      '<div class="gp-scan-result-banner success">',
      '  <div class="gp-scan-result-check"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>',
      '  <h3 class="gp-scan-result-title">Document Identified</h3>',
      '  <p class="gp-scan-result-desc">AI has classified your document and filed it to your documents page.</p>',
      '</div>',
      '<div class="gp-scan-class-card">',
      '  <div class="gp-scan-class-top">',
      '    <div class="gp-scan-class-icon"><svg viewBox="0 0 24 24">' + iconPath + '</svg></div>',
      '    <div class="gp-scan-class-info">',
      '      <p class="gp-scan-class-label">' + label + '</p>',
      '      <p class="gp-scan-class-sublabel">' + (desc || 'Qualification document') + '</p>',
      '    </div>',
      '  </div>'
    ];

    if (confidence !== null) {
      html.push(
        '<div class="gp-scan-conf">',
        '  <div class="gp-scan-conf-header">',
        '    <span class="gp-scan-conf-label">AI Confidence</span>',
        '    <span class="gp-scan-conf-value">' + confidence + '%</span>',
        '  </div>',
        '  <div class="gp-scan-conf-track"><div class="gp-scan-conf-fill ' + confClass + '" style="width:' + confidence + '%"></div></div>',
        '</div>'
      );
    }

    if (reason) {
      html.push('<div class="gp-scan-reason">' + reason + '</div>');
    }

    html.push(
      '  <div class="gp-scan-filed-tag"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> Filed as ' + label + '</div>',
      '</div>',
      '<div class="gp-scan-result-actions">',
      '  <button class="gp-scan-btn-confirm" type="button" id="gpScanViewDocs">View in My Documents</button>',
      '  <button class="gp-scan-btn-retry" type="button" id="gpScanAnother">Scan another document</button>',
      '</div>'
    );

    var resultEl = document.getElementById('gpScanResultContent');
    if (resultEl) resultEl.innerHTML = html.join('\n');
  }

  function renderErrorResult(message) {
    var html = [
      '<div class="gp-scan-result-banner error">',
      '  <div class="gp-scan-result-check"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>',
      '  <h3 class="gp-scan-result-title">Scan Failed</h3>',
      '  <p class="gp-scan-result-desc">' + (message || 'Something went wrong. Please try again.') + '</p>',
      '</div>',
      '<div class="gp-scan-result-actions">',
      '  <button class="gp-scan-btn-retry" type="button" id="gpScanAnother">Try again</button>',
      '</div>'
    ];
    var resultEl = document.getElementById('gpScanResultContent');
    if (resultEl) resultEl.innerHTML = html.join('\n');
  }

  /* ─── Submission ─── */
  function delay(ms, fn) {
    return new Promise(function (resolve) {
      setTimeout(function () { if (fn) fn(); resolve(); }, ms);
    });
  }

  function handleSubmit() {
    if (!selectedFile) return;

    showStep('scanning');
    resetPhases();
    setPhase(0);

    var file = selectedFile;

    readTextSnippet(file).then(function (extracted) {
      return delay(600, function () { setPhase(1); }).then(function () {
        var textEl = document.getElementById('gpScanText');
        var payload = {
          fileName: file.name || 'document',
          mimeType: file.type || '',
          sizeBytes: Number(file.size || 0),
          textSnippet: ((textEl && textEl.value) ? textEl.value : '') + '\n' + extracted
        };
        return delay(400, function () { setPhase(2); }).then(function () {
          return fetch('/api/ai/scan-qualification', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
        });
      });
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok || !data || !data.ok || !data.classification || !data.classification.key) {
          throw new Error(data && data.message ? data.message : 'Could not identify this document. Please try again.');
        }
        return delay(500, function () { setPhase(3); }).then(function () {
          var docsState = getDocumentsState();
          if (!docsState.docs || typeof docsState.docs !== 'object') docsState.docs = {};
          docsState.docs[data.classification.key] = {
            uploaded: true,
            fileName: file.name,
            status: 'under_review',
            source: 'ai_scan',
            updatedAt: new Date().toISOString(),
            confidence: typeof data.classification.confidence === 'number' ? data.classification.confidence : null
          };
          saveDocumentsState(docsState);
          return delay(500);
        }).then(function () {
          completeAllPhases();
          return delay(600);
        }).then(function () {
          showStep('result');
          renderSuccessResult(data.classification, file.name);
        });
      });
    }).catch(function (err) {
      showStep('result');
      renderErrorResult(err && err.message ? err.message : 'Something went wrong.');
    });
  }

  /* ─── Nav button builders ─── */
  function buildDesktopNavButton() {
    var navMenu = document.querySelector('.nav-menu');
    if (!navMenu || navMenu.querySelector('[data-qual-scan-trigger="desktop"]')) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-action nav-item gp-qual-scan-desktop';
    btn.setAttribute('data-qual-scan-trigger', 'desktop');
    btn.setAttribute('aria-label', 'Scan qualification');
    btn.innerHTML = '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M4 7V5a1 1 0 0 1 1-1h2"></path><path d="M20 7V5a1 1 0 0 0-1-1h-2"></path><path d="M4 17v2a1 1 0 0 0 1 1h2"></path><path d="M20 17v2a1 1 0 0 1-1 1h-2"></path><path d="M8 12h8"></path><path d="M12 8v8"></path></svg><span>Scan</span>';
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openModal(); });

    var accountNode = navMenu.querySelector('.account-nav-wrap') || navMenu.querySelector('.account-pill');
    if (accountNode && accountNode.parentNode === navMenu) navMenu.insertBefore(btn, accountNode);
    else navMenu.appendChild(btn);
  }

  function buildMobileNavButtons() {
    var containers = document.querySelectorAll('.bottom-nav, .mobile-nav');
    containers.forEach(function (container) {
      if (container.querySelector('[data-qual-scan-trigger="mobile"]')) return;

      var isBottom = container.classList.contains('bottom-nav');
      var cls = isBottom ? 'bottom-tab' : 'mobile-tab';
      var iconCls = isBottom ? 'bottom-tab-icon' : 'mobile-tab-icon';
      var labelCls = isBottom ? 'bottom-tab-label' : 'mobile-tab-label';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = cls + ' gp-qual-scan-mobile-tab';
      btn.setAttribute('data-qual-scan-trigger', 'mobile');
      btn.setAttribute('aria-label', 'Scan qualification');
      btn.innerHTML = '<span class="' + iconCls + ' gp-qual-scan-mobile-icon">' + scanIconSvg() + '</span><span class="' + labelCls + '">Scan</span>';
      btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openModal(); });

      var beforeIndex = Math.ceil(container.children.length / 2);
      var ref = container.children[beforeIndex] || null;
      container.insertBefore(btn, ref);

      if (container.style && !container.dataset.gpScanGridAdjusted) {
        container.style.gridTemplateColumns = 'repeat(5, minmax(0, 1fr))';
        container.dataset.gpScanGridAdjusted = '1';
      }
    });
  }

  // Expose globally so buttons can use onclick fallback
  window.gpOpenScanModal = openModal;

  /* ─── Install ─── */
  function install() {
    ensureStyles();
    ensureModal(); // Pre-create modal in DOM
    buildDesktopNavButton();
    buildMobileNavButtons();

    // Bind click + touchend directly to all scan trigger buttons
    function bindScanTrigger(el) {
      if (!el || el.__gpScanBound) return;
      el.__gpScanBound = true;
      el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openModal();
      });
      el.addEventListener('touchend', function (e) {
        e.preventDefault();
        openModal();
      }, { passive: false });
    }

    var existingTriggers = document.querySelectorAll('[data-qual-scan-trigger]');
    for (var i = 0; i < existingTriggers.length; i++) {
      bindScanTrigger(existingTriggers[i]);
    }

    document.addEventListener('click', function (event) {
      var target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      // Open scan modal
      var trigger = target.closest('[data-qual-scan-trigger]');
      if (trigger) {
        event.preventDefault();
        event.stopPropagation();
        openModal();
        return;
      }

      // Close
      if (target.closest('[data-scan-close]')) {
        event.preventDefault();
        closeModal();
        return;
      }

      // Dropzone click -> open file picker
      var dropzone = target.closest('#gpScanDropzone');
      if (dropzone) {
        var fileInput = document.getElementById('gpScanFileInput');
        if (fileInput) fileInput.click();
        return;
      }

      // Remove file
      if (target.closest('#gpScanFileRemove')) {
        setSelectedFile(null);
        var input = document.getElementById('gpScanFileInput');
        if (input) input.value = '';
        return;
      }

      // Text toggle
      if (target.id === 'gpScanTextToggle' || target.closest('#gpScanTextToggle')) {
        var textArea = document.getElementById('gpScanText');
        var toggleBtn = document.getElementById('gpScanTextToggle');
        if (textArea) {
          var showing = textArea.classList.contains('show');
          textArea.classList.toggle('show', !showing);
          if (toggleBtn) toggleBtn.textContent = showing ? '+ Add text from document (improves accuracy)' : '- Hide text field';
          if (!showing) textArea.focus();
        }
        return;
      }

      // Submit
      if (target.id === 'gpScanSubmit' || target.closest('#gpScanSubmit')) {
        event.preventDefault();
        handleSubmit();
        return;
      }

      // View docs
      if (target.id === 'gpScanViewDocs' || target.closest('#gpScanViewDocs')) {
        closeModal();
        window.location.href = '/pages/my-documents.html';
        return;
      }

      // Scan another
      if (target.id === 'gpScanAnother' || target.closest('#gpScanAnother')) {
        resetModal();
        return;
      }

      // Backdrop click to close
      var modal = document.getElementById(MODAL_ID);
      if (!modal || !modal.classList.contains('show')) return;
      if (target === modal) closeModal();
    }, true);

    // File input change
    document.addEventListener('change', function (event) {
      if (event.target && event.target.id === 'gpScanFileInput') {
        var file = event.target.files && event.target.files[0];
        if (file) setSelectedFile(file);
      }
    });

    // Drag and drop
    document.addEventListener('dragover', function (event) {
      var dropzone = document.getElementById('gpScanDropzone');
      if (!dropzone) return;
      var modal = document.getElementById(MODAL_ID);
      if (!modal || !modal.classList.contains('show')) return;
      event.preventDefault();
      dropzone.classList.add('drag-over');
    });

    document.addEventListener('dragleave', function (event) {
      var dropzone = document.getElementById('gpScanDropzone');
      if (!dropzone) return;
      if (event.target === dropzone || (event.target instanceof Element && !dropzone.contains(event.target))) {
        dropzone.classList.remove('drag-over');
      }
    });

    document.addEventListener('drop', function (event) {
      var dropzone = document.getElementById('gpScanDropzone');
      if (!dropzone) return;
      var modal = document.getElementById(MODAL_ID);
      if (!modal || !modal.classList.contains('show')) return;
      dropzone.classList.remove('drag-over');

      if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
        event.preventDefault();
        setSelectedFile(event.dataTransfer.files[0]);
      }
    });

    // ESC key
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeModal();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
