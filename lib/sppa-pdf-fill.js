'use strict';

var fs = require('fs');
var path = require('path');
var { PDFDocument, PDFName, PDFString, rgb, StandardFonts } = require('pdf-lib');

var TEMPLATE_PATH = path.join(__dirname, '..', 'documents', 'sppa-00-template.pdf');

var CONFLICT_DETAILS_TEXT =
  'The supervisor is the practice owner. An email to the AHPRA officer will be sent directly ' +
  'explaining how any future potential conflicts of interest will be handled.';

// Q7 radio button option names (discovered from the actual PDF form fields)
var Q7_YES_OPTION = 'b75c775346e3bb53-ce629a18df709c9f';
var Q7_NO_OPTION = 'b75c775446e3bb54-ce629a17df709c9e';

// Q12 "hours of supervised practice" — the template's field name IS this sentence.
var Q12_HOURS_FIELD = 'Refer to Note C in Notes at the end of this form to help complete the plan';
var Q12_START_DATE_FIELD = 'ProposedDateSP-start';
var SPPA_DEFAULT_HOURS_TEXT = '40hrs Per Week';

// The radio groups GP Link answers on every form. After the fill, the selected option of each
// gets an X drawn into the page content itself — field appearance states did not survive at
// least one real print → scan round-trip (Dr Mercy's return lost Q14/Q17/Q19 while keeping
// Q6/Q8), and ink on the page cannot be lost.
var BAKED_RADIO_FIELDS = ['q6', 'q7', 'q8', 'q14', 'q17', 'q19'];

// A stray FreeText annotation reading "40hrs" sits BELOW the Q12 hours box in the template
// (left over from the template's preparation; the in-box value is "40hrs Per Week"). It is
// deleted from every form we send, and whited out on legacy scans. Template coordinates.
var STRAY_HOURS_NOTE = { pageIndex: 5, rect: [57.9, 204.9, 90.0, 215.6] };

// "Attach" checkbox fields — GP Link already collects these documents separately,
// so we check them all and add a note that documents are provided by GP Link
var ATTACH_FIELDS = [
  'Attach_SectionB1', 'Attach_SectionB_Q3', 'Attach_SectionB_Q5',
  'Attach_SectionC_Q6', 'Attach_SectionC_Question9',
  'Attach_SectionD_Question10', 'Attach_SectionD_Question10b', 'Attach_SectionD_Question11',
  'Attach_SectionE_Question15', 'Attach_SectionF_Question16',
  'Attach_SectionG_Question18', 'Attach_SectionH_Question19',
  'Attach_SectionK'
];

// Checklist items at the end of the form
var CHECKLIST_FIELDS = [
  'cb_Checklist1', 'cb_Checklist2', 'cb_Checklist3', 'cb_Checklist4',
  'cb_Checklist5', 'cb_Checklist6', 'cb_Checklist7', 'cb_Checklist8',
  'cb_Checklist9', 'cb_Checklist10', 'cb_Checklist11', 'cb_Checklist12', 'cb_Checklist13'
];

// Rebuild a text field's appearance stream so its value renders INSIDE the box. The template's
// own appearance for the Q12 hours field paints the text below the box, which reads as "blank"
// once the form is printed and scanned back (Dr Mercy Obanimoh's return, 2026-08-27).
function _setTextFieldAppearance(pdfDoc, field, text) {
  var rect = field.get(PDFName.of('Rect'));
  if (!rect) return;
  var x1 = 0, y1 = 0, x2 = 100, y2 = 12;
  try {
    x1 = Number(pdfDoc.context.lookup(rect.get(0))) || 0;
    y1 = Number(pdfDoc.context.lookup(rect.get(1))) || 0;
    x2 = Number(pdfDoc.context.lookup(rect.get(2))) || 100;
    y2 = Number(pdfDoc.context.lookup(rect.get(3))) || 12;
  } catch (e) {}
  var width = Math.abs(x2 - x1);
  var height = Math.abs(y2 - y1);
  if (width < 1) width = 100;
  if (height < 1) height = 12;
  var fontSize = Math.min(10, height - 2);
  if (fontSize < 4) fontSize = 8;

  var textVal = String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  var streamContent = '/Tx BMC\nq\n1 1 ' + (width - 2) + ' ' + (height - 2) + ' re\nW\nn\nBT\n/Helv ' + fontSize + ' Tf\n0 g\n2 ' + Math.max(2, (height - fontSize) / 2) + ' Td\n(' + textVal + ') Tj\nET\nQ\nEMC';
  var streamBytes = new Uint8Array(Buffer.from(streamContent));
  // NOTE: pdf-lib dict keys/values must NOT carry a leading slash — '/Type' becomes a key
  // literally named "/Type" (serialized #2FType), which strict renderers (macOS Preview /
  // Quick Look, print pipelines) reject, leaving the field visually blank.
  var streamRef = pdfDoc.context.register(pdfDoc.context.stream(streamBytes, {
    Type: 'XObject', Subtype: 'Form', FormType: 1,
    BBox: [0, 0, width, height],
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: { Font: { Helv: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' } } }
  }));
  var ap = field.get(PDFName.of('AP'));
  if (!ap) {
    field.set(PDFName.of('AP'), pdfDoc.context.obj({ N: streamRef }));
  } else {
    ap.set(PDFName.of('N'), streamRef);
  }
}

// Rebuild a COMB text field's appearance: one character per cell, evenly spaced across the
// box (the start-date field is a 10-cell comb — DD/MM/YYYY — and a single left-aligned run
// bunches up over the first cells instead of landing one digit per box).
function _setCombFieldAppearance(pdfDoc, field, text, maxLen) {
  var rect = field.get(PDFName.of('Rect'));
  if (!rect) return;
  var x1 = 0, y1 = 0, x2 = 100, y2 = 12;
  try {
    x1 = Number(pdfDoc.context.lookup(rect.get(0))) || 0;
    y1 = Number(pdfDoc.context.lookup(rect.get(1))) || 0;
    x2 = Number(pdfDoc.context.lookup(rect.get(2))) || 100;
    y2 = Number(pdfDoc.context.lookup(rect.get(3))) || 12;
  } catch (e) {}
  var width = Math.abs(x2 - x1);
  var height = Math.abs(y2 - y1);
  var chars = String(text).split('');
  var cells = Math.max(maxLen || chars.length, chars.length);
  var cellW = width / cells;
  var fontSize = Math.min(11, height - 4);
  if (fontSize < 4) fontSize = 8;

  var ops = ['/Tx BMC', 'q', 'BT', '/Helv ' + fontSize + ' Tf', '0 g'];
  var baseY = Math.max(2, (height - fontSize) / 2);
  for (var i = 0; i < chars.length; i++) {
    var ch = chars[i].replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    // Helvetica digits are ~0.556em wide; center each char in its cell.
    var cx = cellW * i + cellW / 2 - fontSize * 0.278;
    ops.push('1 0 0 1 ' + cx.toFixed(2) + ' ' + baseY.toFixed(2) + ' Tm');
    ops.push('(' + ch + ') Tj');
  }
  ops.push('ET', 'Q', 'EMC');
  var streamBytes = new Uint8Array(Buffer.from(ops.join('\n')));
  var streamRef = pdfDoc.context.register(pdfDoc.context.stream(streamBytes, {
    Type: 'XObject', Subtype: 'Form', FormType: 1,
    BBox: [0, 0, width, height],
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: { Font: { Helv: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' } } }
  }));
  var ap = field.get(PDFName.of('AP'));
  if (!ap) {
    field.set(PDFName.of('AP'), pdfDoc.context.obj({ N: streamRef }));
  } else {
    ap.set(PDFName.of('N'), streamRef);
  }
}

// Draw an X directly into the page content over a checkbox/radio widget. Field appearance
// states can silently drop out of a print → scan round-trip; ink drawn on the page itself
// cannot (used to guarantee Q14 visibly reads NO on every copy of the form).
function _drawXOverWidgetRef(pdfDoc, widgetRef) {
  if (!widgetRef) return;
  var wanted = String(widgetRef);
  var widget = pdfDoc.context.lookup(widgetRef);
  if (!widget) return;
  var rect = widget.get(PDFName.of('Rect'));
  if (!rect) return;
  var x1, y1, x2, y2;
  try {
    x1 = Number(pdfDoc.context.lookup(rect.get(0)));
    y1 = Number(pdfDoc.context.lookup(rect.get(1)));
    x2 = Number(pdfDoc.context.lookup(rect.get(2)));
    y2 = Number(pdfDoc.context.lookup(rect.get(3)));
  } catch (e) { return; }
  if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) return;

  var pages = pdfDoc.getPages();
  for (var p = 0; p < pages.length; p++) {
    var annots;
    try { annots = pages[p].node.Annots(); } catch (e) { annots = null; }
    if (!annots) continue;
    for (var a = 0; a < annots.size(); a++) {
      if (String(annots.get(a)) !== wanted) continue;
      var inset = 2.2;
      var lo = { x: Math.min(x1, x2) + inset, y: Math.min(y1, y2) + inset };
      var hi = { x: Math.max(x1, x2) - inset, y: Math.max(y1, y2) - inset };
      var line = { thickness: 1.6, color: rgb(0.05, 0.05, 0.05) };
      pages[p].drawLine(Object.assign({ start: { x: lo.x, y: lo.y }, end: { x: hi.x, y: hi.y } }, line));
      pages[p].drawLine(Object.assign({ start: { x: lo.x, y: hi.y }, end: { x: hi.x, y: lo.y } }, line));
      return;
    }
  }
}

/**
 * Fill Q7 and mark attach/checklist fields on the SPPA-00 PDF template.
 * Uses low-level pdf-lib API because the high-level form API crashes on this PDF.
 *
 * @param {Object} params
 * @param {boolean} params.isConflict - true = YES, false = NO
 * @param {string} [params.detailsText] - Custom details text (defaults to standard conflict message when isConflict=true)
 * @param {boolean} [params.markAttachFields] - Check all "Attach" checkboxes (default: true)
 * @returns {Promise<Buffer>} Modified PDF as a Node.js Buffer
 */
async function fillSppaQ7(params) {
  var templateBytes = fs.readFileSync(TEMPLATE_PATH);
  var pdfDoc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });

  var acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
  var fieldsArray = acroForm.lookup(PDFName.of('Fields'));
  var markAttach = params.markAttachFields !== false;

  for (var i = 0; i < fieldsArray.size(); i++) {
    var ref = fieldsArray.get(i);
    var field = pdfDoc.context.lookup(ref);
    if (!field) continue;
    var tVal = field.get(PDFName.of('T'));
    if (!tVal) continue;
    var name = tVal.decodeText ? tVal.decodeText() : String(tVal);

    if (name === 'q7') {
      var selectedOption = params.isConflict ? Q7_YES_OPTION : Q7_NO_OPTION;

      field.set(PDFName.of('V'), PDFName.of(selectedOption));

      var kids = field.get(PDFName.of('Kids'));
      if (kids) {
        var kid0 = pdfDoc.context.lookup(kids.get(0));
        var kid1 = pdfDoc.context.lookup(kids.get(1));

        if (params.isConflict) {
          kid0.set(PDFName.of('AS'), PDFName.of(Q7_YES_OPTION));
          kid1.set(PDFName.of('AS'), PDFName.of('Off'));
        } else {
          kid0.set(PDFName.of('AS'), PDFName.of('Off'));
          kid1.set(PDFName.of('AS'), PDFName.of(Q7_NO_OPTION));
        }
      }
    }

    if (name === 'Conflicts_Question7') {
      if (params.isConflict) {
        var details = params.detailsText || CONFLICT_DETAILS_TEXT;
        field.set(PDFName.of('V'), PDFString.of(details));
      } else {
        field.delete(PDFName.of('V'));
      }
    }

    // Q14 (progression through supervision levels) is always NO for GP Link candidates. The
    // template carries NO in the field data, but that state can vanish in a print → scan
    // round-trip; assert the field state AND draw the cross into the page content itself.
    if (name === 'q14') {
      var q14Kids = field.get(PDFName.of('Kids'));
      if (q14Kids && q14Kids.size() >= 2) {
        var q14NoRef = q14Kids.get(1); // kid0 = YES, kid1 = NO on this form
        var q14NoKid = pdfDoc.context.lookup(q14NoRef);
        var q14NoHash = null;
        if (q14NoKid) {
          var q14Ap = q14NoKid.get(PDFName.of('AP'));
          var q14N = q14Ap ? q14Ap.get(PDFName.of('N')) : null;
          if (q14N && q14N.entries) {
            q14N.entries().forEach(function (entry) {
              var opt = String(entry[0]).replace(/^\//, '');
              if (opt !== 'Off') q14NoHash = opt;
            });
          }
        }
        if (q14NoHash) {
          field.set(PDFName.of('V'), PDFName.of(q14NoHash));
          for (var qk = 0; qk < q14Kids.size(); qk++) {
            var q14Kid = pdfDoc.context.lookup(q14Kids.get(qk));
            if (q14Kid) q14Kid.set(PDFName.of('AS'), PDFName.of(qk === 1 ? q14NoHash : 'Off'));
          }
        }
      }
    }

    // Q12 hours of supervised practice: make sure the value is set AND renders inside the box
    // (the template's own appearance painted it below the box, which scans back as "blank").
    if (name === Q12_HOURS_FIELD) {
      var hoursV = field.get(PDFName.of('V'));
      var hoursText = '';
      if (hoursV) {
        hoursText = (hoursV.decodeText ? hoursV.decodeText() : String(hoursV)).replace(/^\(|\)$/g, '').trim();
      }
      if (!hoursText) {
        hoursText = SPPA_DEFAULT_HOURS_TEXT;
        field.set(PDFName.of('V'), PDFString.of(hoursText));
      }
      _setTextFieldAppearance(pdfDoc, field, hoursText);
    }

    // Check all "Attach" and checklist checkboxes — documents provided by GP Link
    if (markAttach && (ATTACH_FIELDS.indexOf(name) >= 0 || CHECKLIST_FIELDS.indexOf(name) >= 0)) {
      // Checkbox fields: set V to /Yes and AS to /Yes on the widget
      field.set(PDFName.of('V'), PDFName.of('Yes'));
      field.set(PDFName.of('AS'), PDFName.of('Yes'));
      var cbKids = field.get(PDFName.of('Kids'));
      if (cbKids) {
        for (var k = 0; k < cbKids.size(); k++) {
          var cbKid = pdfDoc.context.lookup(cbKids.get(k));
          if (cbKid) cbKid.set(PDFName.of('AS'), PDFName.of('Yes'));
        }
      }
    }
  }

  // Bake an X into the page content over the SELECTED option of every radio GP Link answers
  // (q6/q7/q8 NO-unless-conflict, q14 NO, q17 YES, q19 YES) — see BAKED_RADIO_FIELDS.
  for (var b = 0; b < fieldsArray.size(); b++) {
    var bField = pdfDoc.context.lookup(fieldsArray.get(b));
    if (!bField) continue;
    var bT = bField.get(PDFName.of('T'));
    if (!bT) continue;
    var bName = bT.decodeText ? bT.decodeText() : String(bT);
    if (BAKED_RADIO_FIELDS.indexOf(bName) < 0) continue;
    var bKids = bField.get(PDFName.of('Kids'));
    if (!bKids) continue;
    for (var bk = 0; bk < bKids.size(); bk++) {
      var bKid = pdfDoc.context.lookup(bKids.get(bk));
      if (!bKid) continue;
      var bAs = bKid.get(PDFName.of('AS'));
      if (bAs && String(bAs) !== '/Off') _drawXOverWidgetRef(pdfDoc, bKids.get(bk));
    }
  }

  // Delete the stray "40hrs" FreeText note left below the Q12 hours box by the template's
  // preparation — the real value lives in the hours field itself.
  _removeStrayHoursNote(pdfDoc);

  var pdfBytes = await pdfDoc.save({ updateFieldAppearances: false });
  return Buffer.from(pdfBytes);
}

// Remove the leftover "40hrs" FreeText annotation (matched by subtype + exact text, never by
// position, so the two legitimate FreeText notes on that page are untouched).
function _removeStrayHoursNote(pdfDoc) {
  try {
    var pages = pdfDoc.getPages();
    for (var p = 0; p < pages.length; p++) {
      var annots;
      try { annots = pages[p].node.Annots(); } catch (e) { annots = null; }
      if (!annots) continue;
      for (var a = annots.size() - 1; a >= 0; a--) {
        var an = pdfDoc.context.lookup(annots.get(a));
        if (!an || !an.get) continue;
        if (String(an.get(PDFName.of('Subtype')) || '') !== '/FreeText') continue;
        var contents = an.get(PDFName.of('Contents'));
        var text = contents && contents.decodeText ? contents.decodeText() : (contents ? String(contents) : '');
        if (text.replace(/^\(|\)$/g, '').trim() === '40hrs') annots.remove(a);
      }
    }
  } catch (err) {
    console.error('[SPPA] stray hours note removal error:', err.message);
  }
}

/**
 * Extract alternate supervisor names from a returned SPPA-00 PDF.
 * Reads form fields "Name of alternate supervisor 1" and "Name of alternate supervisor 2".
 * Falls back to AI extraction if form fields are empty (e.g. scanned/printed PDF).
 *
 * @param {Buffer} pdfBuffer - The returned SPPA-00 PDF
 * @returns {Promise<string[]>} Array of alt supervisor names (may be empty)
 */
async function extractAltSupervisorNames(pdfBuffer) {
  var names = [];
  try {
    var pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    var acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
    if (!acroForm) return names;
    var fieldsArray = acroForm.lookup(PDFName.of('Fields'));
    if (!fieldsArray) return names;

    for (var i = 0; i < fieldsArray.size(); i++) {
      var ref = fieldsArray.get(i);
      var field = pdfDoc.context.lookup(ref);
      if (!field) continue;
      var tVal = field.get(PDFName.of('T'));
      if (!tVal) continue;
      var name = tVal.decodeText ? tVal.decodeText() : String(tVal);

      if (name === 'Name of alternate supervisor 1' || name === 'Name of alternate supervisor 2') {
        var vVal = field.get(PDFName.of('V'));
        if (vVal) {
          var text = vVal.decodeText ? vVal.decodeText() : String(vVal);
          text = text.replace(/^\(|\)$/g, '').trim();
          if (text && text.length > 1) names.push(text);
        }
      }
    }
  } catch (err) {
    console.error('[SPPA] extractAltSupervisorNames PDF parse error:', err.message);
  }

  // If form fields empty, try AI extraction from PDF content
  if (names.length === 0 && process.env.ANTHROPIC_API_KEY) {
    try {
      var b64 = pdfBuffer.toString('base64');
      // Only attempt if PDF is under 5MB (API limit)
      if (b64.length < 5 * 1024 * 1024) {
        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 20000);
        var res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', signal: controller.signal,
          headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-6', max_tokens: 200, temperature: 0,
            messages: [{ role: 'user', content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
              { type: 'text', text: 'This is an SPPA-00 form. Look at Section K (Alternate Supervisors). Extract ONLY the names of alternate supervisors listed there. Return JSON: {"names": ["Name 1", "Name 2"]}. If no alternate supervisors are listed, return {"names": []}.' }
            ] }]
          })
        });
        clearTimeout(timeout);
        var data = await res.json();
        var text = data.content && data.content[0] ? data.content[0].text : '';
        var jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          var parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed.names)) names = parsed.names.filter(function (n) { return n && n.trim().length > 1; });
        }
      }
    } catch (aiErr) {
      console.error('[SPPA] AI alt supervisor extraction error:', aiErr.message);
    }
  }

  return names;
}

/**
 * Amend a specific field on an existing SPPA-00 PDF.
 * For RSO-owned fields (Q6-Q8, Q17, Q18, Q19) that AHPRA requests corrections on.
 *
 * @param {Buffer} pdfBuffer - The current SPPA-00 PDF
 * @param {string} fieldName - The PDF form field name to amend
 * @param {string} newValue - The new value to set
 * @returns {Promise<Buffer>} Modified PDF as a Node.js Buffer
 */
async function amendSppaField(pdfBuffer, fieldName, newValue) {
  var pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  var acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
  if (!acroForm) throw new Error('PDF has no form fields');
  var fieldsArray = acroForm.lookup(PDFName.of('Fields'));
  if (!fieldsArray) throw new Error('PDF has no form fields');
  var found = false;

  for (var i = 0; i < fieldsArray.size(); i++) {
    var ref = fieldsArray.get(i);
    var field = pdfDoc.context.lookup(ref);
    if (!field) continue;
    var tVal = field.get(PDFName.of('T'));
    if (!tVal) continue;
    var name = tVal.decodeText ? tVal.decodeText() : String(tVal);
    if (name === fieldName) {
      field.set(PDFName.of('V'), PDFString.of(String(newValue)));
      found = true;
    }
  }

  if (!found) throw new Error('Field not found in PDF: ' + fieldName);
  var pdfBytes;
  try {
    pdfBytes = await pdfDoc.save({ updateFieldAppearances: true });
  } catch (appearErr) {
    console.warn('[SPPA] updateFieldAppearances failed, saving without:', appearErr.message);
    pdfBytes = await pdfDoc.save({ updateFieldAppearances: false });
  }
  return Buffer.from(pdfBytes);
}

/**
 * Extract all form fields from an SPPA-00 PDF — text, radio, and checkbox.
 * Returns an array of { name, value, type, options } for rendering as an editable form.
 */
async function extractSppaFormFields(pdfBuffer) {
  var fields = [];
  try {
    var pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    var acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
    if (!acroForm) return fields;
    var fieldsArray = acroForm.lookup(PDFName.of('Fields'));
    if (!fieldsArray) return fields;

    for (var i = 0; i < fieldsArray.size(); i++) {
      var ref = fieldsArray.get(i);
      var field = pdfDoc.context.lookup(ref);
      if (!field) continue;
      var tVal = field.get(PDFName.of('T'));
      if (!tVal) continue;
      var name = tVal.decodeText ? tVal.decodeText() : String(tVal);
      var ftVal = field.get(PDFName.of('FT'));
      var ft = ftVal ? String(ftVal) : '';
      var vVal = field.get(PDFName.of('V'));
      var value = '';
      if (vVal) {
        value = vVal.decodeText ? vVal.decodeText() : String(vVal);
        value = value.replace(/^\(|\)$/g, '').replace(/^\//, '');
      }

      if (ft === '/Sig') continue; // Skip signatures

      if (ft === '/Tx') {
        // Text field — include even if empty so all fields are editable
        if (name) fields.push({ name: name, value: (value || '').trim(), type: 'text' });
      } else if (ft === '/Btn') {
        // Check if it's a radio group (has kids) or a simple checkbox
        var kids = field.get(PDFName.of('Kids'));
        if (kids && kids.size() > 0) {
          // Radio group — extract option hashes from kid appearance dicts
          var options = [];
          for (var k = 0; k < kids.size(); k++) {
            var kid = pdfDoc.context.lookup(kids.get(k));
            if (!kid) continue;
            var ap = kid.get(PDFName.of('AP'));
            if (ap) {
              var nDict = ap.get(PDFName.of('N'));
              if (nDict && nDict.entries) {
                var entries = nDict.entries();
                for (var e = 0; e < entries.length; e++) {
                  var optName = String(entries[e][0]).replace(/^\//, '');
                  if (optName !== 'Off') options.push({ kid: k, hash: optName });
                }
              }
            }
          }
          // Map kid0 = YES, kid1 = NO for 2-option radios
          var currentValue = value === 'Off' ? 'Off' : value;
          var selectedKid = -1;
          for (var o = 0; o < options.length; o++) {
            if (options[o].hash === currentValue) { selectedKid = options[o].kid; break; }
          }
          var displayValue = selectedKid === 0 ? 'Yes' : selectedKid === 1 ? 'No' : (value || 'Off');
          fields.push({ name: name, value: displayValue, type: 'radio', options: options, rawValue: currentValue });
        } else {
          // Simple checkbox — value is Yes/On/Off
          var cbVal = value === 'Yes' || value === 'On' ? 'Yes' : 'No';
          fields.push({ name: name, value: cbVal, type: 'checkbox' });
        }
      }
    }
  } catch (err) {
    console.error('[SPPA] extractSppaFormFields error:', err.message);
  }
  return fields;
}

/**
 * Amend multiple fields on an SPPA-00 PDF — handles text, radio, and checkbox types.
 */
async function amendSppaFields(pdfBuffer, fieldUpdates) {
  var pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  var acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
  if (!acroForm) throw new Error('PDF has no form fields');
  var fieldsArray = acroForm.lookup(PDFName.of('Fields'));
  if (!fieldsArray) throw new Error('PDF has no form fields');
  var updateMap = {};
  fieldUpdates.forEach(function (u) { updateMap[u.name] = u.value; });
  var amended = 0;

  for (var i = 0; i < fieldsArray.size(); i++) {
    var ref = fieldsArray.get(i);
    var field = pdfDoc.context.lookup(ref);
    if (!field) continue;
    var tVal = field.get(PDFName.of('T'));
    if (!tVal) continue;
    var name = tVal.decodeText ? tVal.decodeText() : String(tVal);
    if (!updateMap.hasOwnProperty(name)) continue;

    var ftVal = field.get(PDFName.of('FT'));
    var ft = ftVal ? String(ftVal) : '';
    var newVal = updateMap[name];

    if (ft === '/Tx') {
      // Text field
      field.set(PDFName.of('V'), PDFString.of(String(newVal)));
      amended++;
    } else if (ft === '/Btn') {
      var kids = field.get(PDFName.of('Kids'));
      if (kids && kids.size() > 0) {
        // Radio group — "Yes" selects kid0, "No" selects kid1, anything else treated as a hash
        var targetKid = -1;
        if (newVal === 'Yes' || newVal === 'yes') targetKid = 0;
        else if (newVal === 'No' || newVal === 'no' || newVal === 'Off') targetKid = 1;

        // Find the option hash for the target kid
        var targetHash = null;
        for (var k = 0; k < kids.size(); k++) {
          var kid = pdfDoc.context.lookup(kids.get(k));
          if (!kid) continue;
          var ap = kid.get(PDFName.of('AP'));
          if (ap) {
            var nDict = ap.get(PDFName.of('N'));
            if (nDict && nDict.entries) {
              var entries = nDict.entries();
              for (var e = 0; e < entries.length; e++) {
                var optName = String(entries[e][0]).replace(/^\//, '');
                if (optName !== 'Off') {
                  if (k === targetKid) targetHash = optName;
                  // Also check if newVal is a raw hash match
                  if (optName === newVal) { targetKid = k; targetHash = optName; }
                }
              }
            }
          }
        }

        if (targetHash) {
          // Set V on parent
          field.set(PDFName.of('V'), PDFName.of(targetHash));
          // Set AS on each kid
          for (var k2 = 0; k2 < kids.size(); k2++) {
            var kid2 = pdfDoc.context.lookup(kids.get(k2));
            if (!kid2) continue;
            if (k2 === targetKid) {
              kid2.set(PDFName.of('AS'), PDFName.of(targetHash));
            } else {
              kid2.set(PDFName.of('AS'), PDFName.of('Off'));
            }
          }
          amended++;
        } else if (newVal === 'Off' || newVal === 'No' || newVal === 'no') {
          // Deselect all
          field.set(PDFName.of('V'), PDFName.of('Off'));
          for (var k3 = 0; k3 < kids.size(); k3++) {
            var kid3 = pdfDoc.context.lookup(kids.get(k3));
            if (kid3) kid3.set(PDFName.of('AS'), PDFName.of('Off'));
          }
          amended++;
        }
      } else {
        // Simple checkbox
        if (newVal === 'Yes' || newVal === 'yes' || newVal === 'On' || newVal === true) {
          field.set(PDFName.of('V'), PDFName.of('Yes'));
          field.set(PDFName.of('AS'), PDFName.of('Yes'));
        } else {
          field.set(PDFName.of('V'), PDFName.of('Off'));
          field.set(PDFName.of('AS'), PDFName.of('Off'));
        }
        amended++;
      }
    }
  }

  // Manually rebuild appearance streams for amended text fields
  // (high-level flatten/updateFieldAppearances crashes on this PDF's malformed fields)
  for (var i2 = 0; i2 < fieldsArray.size(); i2++) {
    var ref2 = fieldsArray.get(i2);
    var field2 = pdfDoc.context.lookup(ref2);
    if (!field2) continue;
    var tVal2 = field2.get(PDFName.of('T'));
    if (!tVal2) continue;
    var name2 = tVal2.decodeText ? tVal2.decodeText() : String(tVal2);
    var ft2 = field2.get(PDFName.of('FT'));
    if (!ft2 || String(ft2) !== '/Tx' || !updateMap.hasOwnProperty(name2)) continue;

    // Get the field's rectangle (position/size) from the widget annotation
    var rect = field2.get(PDFName.of('Rect'));
    if (!rect) continue;
    var x1 = 0, y1 = 0, x2 = 100, y2 = 12;
    try {
      x1 = Number(pdfDoc.context.lookup(rect.get(0))) || 0;
      y1 = Number(pdfDoc.context.lookup(rect.get(1))) || 0;
      x2 = Number(pdfDoc.context.lookup(rect.get(2))) || 100;
      y2 = Number(pdfDoc.context.lookup(rect.get(3))) || 12;
    } catch (e) {}
    var width = Math.abs(x2 - x1);
    var height = Math.abs(y2 - y1);
    if (width < 1) width = 100;
    if (height < 1) height = 12;
    var fontSize = Math.min(10, height - 2);
    if (fontSize < 4) fontSize = 8;

    // Build a minimal appearance stream that renders the text. Dict keys/values must NOT
    // carry a leading slash — '/Type' becomes a key literally named "/Type" (#2FType),
    // which strict renderers (macOS Preview / Quick Look, print) reject as malformed.
    var textVal = String(updateMap[name2]).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    var streamContent = '/Tx BMC\nq\n1 1 ' + (width - 2) + ' ' + (height - 2) + ' re\nW\nn\nBT\n/Helv ' + fontSize + ' Tf\n0 g\n2 ' + Math.max(2, (height - fontSize) / 2) + ' Td\n(' + textVal + ') Tj\nET\nQ\nEMC';
    var streamBytes = new Uint8Array(Buffer.from(streamContent));
    var streamRef = pdfDoc.context.register(pdfDoc.context.stream(streamBytes, {
      Type: 'XObject', Subtype: 'Form', FormType: 1,
      BBox: [0, 0, width, height],
      Matrix: [1, 0, 0, 1, 0, 0],
      Resources: { Font: { Helv: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' } } }
    }));

    // Set the appearance on the field widget
    var ap = field2.get(PDFName.of('AP'));
    if (!ap) {
      field2.set(PDFName.of('AP'), pdfDoc.context.obj({ N: streamRef }));
    } else {
      ap.set(PDFName.of('N'), streamRef);
    }
  }

  var pdfBytes = await pdfDoc.save({ updateFieldAppearances: false });
  return { buffer: Buffer.from(pdfBytes), amended: amended };
}

/**
 * Auto-fill the Q12 proposed start date on a practice-returned SPPA-00 when the practice left
 * it blank. Business rule (owner, 2026-08-27): the start date defaults to 5 months after the
 * practice sent the form back. Only works on a fillable PDF — a printed-and-scanned return has
 * no form fields, in which case this reports why and leaves the PDF untouched.
 *
 * @param {Buffer} pdfBuffer - The practice-returned SPPA-00
 * @param {string} dateText - The date to write, already formatted (DD/MM/YYYY)
 * @returns {Promise<{filled: boolean, reason: string, buffer: Buffer|null}>}
 */
async function autofillSppaStartDate(pdfBuffer, dateText) {
  try {
    var pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    var acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
    if (!acroForm) return { filled: false, reason: 'no_form_fields', buffer: null };
    var fieldsArray = acroForm.lookup(PDFName.of('Fields'));
    if (!fieldsArray) return { filled: false, reason: 'no_form_fields', buffer: null };

    var target = null;
    for (var i = 0; i < fieldsArray.size(); i++) {
      var field = pdfDoc.context.lookup(fieldsArray.get(i));
      if (!field) continue;
      var tVal = field.get(PDFName.of('T'));
      if (!tVal) continue;
      var name = tVal.decodeText ? tVal.decodeText() : String(tVal);
      if (name === Q12_START_DATE_FIELD) { target = field; break; }
    }
    if (!target) return { filled: false, reason: 'field_not_found', buffer: null };

    var existing = target.get(PDFName.of('V'));
    var existingText = '';
    if (existing) {
      existingText = (existing.decodeText ? existing.decodeText() : String(existing)).replace(/^\(|\)$/g, '').trim();
    }
    if (existingText) return { filled: false, reason: 'already_filled', buffer: null };

    target.set(PDFName.of('V'), PDFString.of(String(dateText)));
    // The start-date field is a comb (one cell per character) — distribute the characters
    // across the cells rather than bunching them at the left edge.
    var maxLenVal = target.get(PDFName.of('MaxLen'));
    var maxLen = maxLenVal ? Number(String(maxLenVal)) : 0;
    if (maxLen > 1) _setCombFieldAppearance(pdfDoc, target, String(dateText), maxLen);
    else _setTextFieldAppearance(pdfDoc, target, String(dateText));
    var pdfBytes = await pdfDoc.save({ updateFieldAppearances: false });
    return { filled: true, reason: 'filled', buffer: Buffer.from(pdfBytes) };
  } catch (err) {
    return { filled: false, reason: 'error: ' + err.message, buffer: null };
  }
}

// Template geometry for a named field: which page its widget sits on, its rect, and the
// template page size — so the same spot can be found on a printed-and-scanned copy.
async function _templateFieldGeometry(fieldNames) {
  var templateBytes = fs.readFileSync(TEMPLATE_PATH);
  var pdfDoc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
  var acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
  var fieldsArray = acroForm.lookup(PDFName.of('Fields'));
  var out = { pageCount: pdfDoc.getPageCount(), fields: {} };
  var wantedRefs = {};
  for (var i = 0; i < fieldsArray.size(); i++) {
    var ref = fieldsArray.get(i);
    var field = pdfDoc.context.lookup(ref);
    if (!field) continue;
    var tVal = field.get(PDFName.of('T'));
    if (!tVal) continue;
    var name = tVal.decodeText ? tVal.decodeText() : String(tVal);
    if (fieldNames.indexOf(name) < 0) continue;
    var rect = field.get(PDFName.of('Rect'));
    if (!rect) continue;
    var r = [];
    for (var j = 0; j < 4; j++) r.push(Number(pdfDoc.context.lookup(rect.get(j))));
    wantedRefs[String(ref)] = { name: name, rect: r };
  }
  var pages = pdfDoc.getPages();
  for (var p = 0; p < pages.length; p++) {
    var annots;
    try { annots = pages[p].node.Annots(); } catch (e) { annots = null; }
    if (!annots) continue;
    for (var a = 0; a < annots.size(); a++) {
      var hit = wantedRefs[String(annots.get(a))];
      if (hit) {
        out.fields[hit.name] = { pageIndex: p, rect: hit.rect, pageWidth: pages[p].getWidth(), pageHeight: pages[p].getHeight() };
      }
    }
  }
  return out;
}

// Template geometry for a radio option: the page, rect and page size of one KID widget
// (radio rects live on the kids, not the field). kidIndex: 0/1 per the form's layout.
async function _templateRadioKidGeometry(fieldName, kidIndex) {
  var templateBytes = fs.readFileSync(TEMPLATE_PATH);
  var pdfDoc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
  var acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
  var fieldsArray = acroForm.lookup(PDFName.of('Fields'));
  for (var i = 0; i < fieldsArray.size(); i++) {
    var field = pdfDoc.context.lookup(fieldsArray.get(i));
    if (!field) continue;
    var tVal = field.get(PDFName.of('T'));
    if (!tVal) continue;
    var name = tVal.decodeText ? tVal.decodeText() : String(tVal);
    if (name !== fieldName) continue;
    var kids = field.get(PDFName.of('Kids'));
    if (!kids || kids.size() <= kidIndex) return null;
    var kidRef = kids.get(kidIndex);
    var kid = pdfDoc.context.lookup(kidRef);
    var rect = kid.get(PDFName.of('Rect'));
    if (!rect) return null;
    var r = [];
    for (var j = 0; j < 4; j++) r.push(Number(pdfDoc.context.lookup(rect.get(j))));
    var wantedRef = String(kidRef);
    var pages = pdfDoc.getPages();
    for (var p = 0; p < pages.length; p++) {
      var annots;
      try { annots = pages[p].node.Annots(); } catch (e) { annots = null; }
      if (!annots) continue;
      for (var a = 0; a < annots.size(); a++) {
        if (String(annots.get(a)) === wantedRef) {
          return { pageIndex: p, rect: r, pageWidth: pages[p].getWidth(), pageHeight: pages[p].getHeight() };
        }
      }
    }
  }
  return null;
}

/**
 * Stamp values directly onto a SCANNED (flattened) SPPA-00 — a print-and-scan return has no
 * form fields to fill, so everything is drawn onto the page at the template's position,
 * scaled to the scan's page size. Refuses anything that is not clearly a full 1:1 scan of the
 * 13-page form (page count mismatch, rotated page) — never guesses at a layout.
 *
 * @param {Buffer} pdfBuffer - The scanned SPPA-00
 * @param {Object} values - { startDate?: 'DD/MM/YYYY', hoursText?: '40hrs Per Week',
 *                            whiteOutStrayHours?: bool, crossQ14No?: bool, crossQ17Yes?: bool,
 *                            crossQ19Yes?: bool }
 * @returns {Promise<{filled: boolean, reason: string, buffer: Buffer|null, stamped: string[]}>}
 */
async function stampSppaQ12OnScan(pdfBuffer, values) {
  values = values || {};
  try {
    var pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });

    // A fillable PDF should be filled through its fields, not painted over.
    var acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
    if (acroForm) {
      var fieldsArray = acroForm.lookup(PDFName.of('Fields'));
      if (fieldsArray && fieldsArray.size() > 0) return { filled: false, reason: 'has_form_fields', buffer: null, stamped: [] };
    }

    var wanted = [];
    if (values.startDate) wanted.push(Q12_START_DATE_FIELD);
    if (values.hoursText) wanted.push(Q12_HOURS_FIELD);
    if (!wanted.length && !values.whiteOutStrayHours && !values.crossQ14No && !values.crossQ17Yes && !values.crossQ19Yes) {
      return { filled: false, reason: 'nothing_to_stamp', buffer: null, stamped: [] };
    }

    var geo = await _templateFieldGeometry(wanted.length ? wanted : [Q12_HOURS_FIELD]);
    if (pdfDoc.getPageCount() !== geo.pageCount) return { filled: false, reason: 'scan_layout_unknown', buffer: null, stamped: [] };

    // Scanners crop the page edges rather than scaling the print, so pure proportional
    // scaling lands a few points low/left of the printed position — nudges toward the 1:1
    // position, calibrated against a real practice scan. Placement tolerance is forgiving:
    // a stamp just has to sit legibly in its box like a handwritten entry would.
    function scaled(g) {
      var page = pdfDoc.getPage(g.pageIndex);
      if (page.getRotation().angle) return null;
      var sx = page.getWidth() / g.pageWidth;
      var sy = page.getHeight() / g.pageHeight;
      return {
        page: page,
        x1: Math.min(g.rect[0], g.rect[2]) * sx,
        y1: Math.min(g.rect[1], g.rect[3]) * sy,
        w: Math.abs(g.rect[2] - g.rect[0]) * sx,
        h: Math.abs(g.rect[3] - g.rect[1]) * sy
      };
    }

    var font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    var ink = rgb(0.1, 0.1, 0.1);
    var stamped = [];

    for (var w = 0; w < wanted.length; w++) {
      var g = geo.fields[wanted[w]];
      if (!g) continue;
      var s = scaled(g);
      if (!s) return { filled: false, reason: 'scan_layout_unknown', buffer: null, stamped: [] };
      var fontSize = Math.max(8, Math.min(11, s.h - 5));
      if (wanted[w] === Q12_START_DATE_FIELD) {
        // The printed start-date box is a 10-cell comb (DD/MM/YYYY) — place one character
        // per cell so the digits land in their boxes instead of bunching at the left edge.
        var chars = String(values.startDate).split('');
        var cells = Math.max(10, chars.length);
        var cellW = s.w / cells;
        for (var c = 0; c < chars.length; c++) {
          s.page.drawText(chars[c], {
            x: s.x1 + 7 + cellW * c + cellW / 2 - fontSize * 0.278,
            y: s.y1 + (s.h - fontSize) / 2 + 6,
            size: fontSize, font: font, color: ink
          });
        }
        stamped.push('start_date');
      } else {
        s.page.drawText(String(values.hoursText), {
          x: s.x1 + 9,
          y: s.y1 + (s.h - fontSize) / 2 + 10,
          size: fontSize, font: font, color: ink
        });
        stamped.push('hours');
      }
    }

    // White out the stray "40hrs" note printed below the hours box on forms sent before the
    // template fix (the note itself is deleted from every new form we send).
    if (values.whiteOutStrayHours) {
      var strayPage = pdfDoc.getPage(STRAY_HOURS_NOTE.pageIndex);
      if (!strayPage.getRotation().angle) {
        var ssx = strayPage.getWidth() / 595.276;
        var ssy = strayPage.getHeight() / 841.89;
        var sr = STRAY_HOURS_NOTE.rect;
        strayPage.drawRectangle({
          x: sr[0] * ssx - 4, y: sr[1] * ssy - 2,
          width: (sr[2] - sr[0]) * ssx + 16, height: (sr[3] - sr[1]) * ssy + 12,
          color: rgb(1, 1, 1)
        });
        stamped.push('stray_hours_whiteout');
      }
    }

    // Cross the GP Link standard answers that failed to survive an older form's
    // print → scan round-trip: Q14 NO (kid 1), Q17 YES (kid 0) and Q19 YES (kid 0). The
    // per-cross dy differs because the print is shrunk ~95% ("fit to page"), so the vertical
    // error grows with the box's height on the page — offsets calibrated against a real scan.
    var crosses = [];
    if (values.crossQ14No) crosses.push({ field: 'q14', kid: 1, tag: 'q14_no', dx: 7, dy: 7 });
    if (values.crossQ17Yes) crosses.push({ field: 'q17', kid: 0, tag: 'q17_yes', dx: 7, dy: 5 });
    if (values.crossQ19Yes) crosses.push({ field: 'q19', kid: 0, tag: 'q19_yes', dx: 7, dy: -3 });
    for (var cr = 0; cr < crosses.length; cr++) {
      var rg = await _templateRadioKidGeometry(crosses[cr].field, crosses[cr].kid);
      if (!rg) continue;
      var rs = scaled(rg);
      if (!rs) continue;
      var inset = 2.2;
      var line = { thickness: 1.6, color: ink };
      var lx1 = rs.x1 + crosses[cr].dx + inset, ly1 = rs.y1 + crosses[cr].dy + inset;
      var lx2 = rs.x1 + crosses[cr].dx + rs.w - inset, ly2 = rs.y1 + crosses[cr].dy + rs.h - inset;
      rs.page.drawLine(Object.assign({ start: { x: lx1, y: ly1 }, end: { x: lx2, y: ly2 } }, line));
      rs.page.drawLine(Object.assign({ start: { x: lx1, y: ly2 }, end: { x: lx2, y: ly1 } }, line));
      stamped.push(crosses[cr].tag);
    }

    if (!stamped.length) return { filled: false, reason: 'scan_layout_unknown', buffer: null, stamped: [] };
    var pdfBytes = await pdfDoc.save({ updateFieldAppearances: false });
    return { filled: true, reason: 'stamped_on_scan', buffer: Buffer.from(pdfBytes), stamped: stamped };
  } catch (err) {
    return { filled: false, reason: 'error: ' + err.message, buffer: null, stamped: [] };
  }
}

module.exports = { fillSppaQ7, extractAltSupervisorNames, amendSppaField, amendSppaFields, extractSppaFormFields, autofillSppaStartDate, stampSppaQ12OnScan, CONFLICT_DETAILS_TEXT, SPPA_DEFAULT_HOURS_TEXT, Q12_START_DATE_FIELD, Q12_HOURS_FIELD };
