'use strict';

var fs = require('fs');
var path = require('path');
var { PDFDocument, PDFName, PDFString } = require('pdf-lib');

var TEMPLATE_PATH = path.join(__dirname, '..', 'documents', 'sppa-00-template.pdf');

var CONFLICT_DETAILS_TEXT =
  'The supervisor is the practice owner. An email to the AHPRA officer will be sent directly ' +
  'explaining how any future potential conflicts of interest will be handled.';

// Q7 radio button option names (discovered from the actual PDF form fields)
var Q7_YES_OPTION = 'b75c775346e3bb53-ce629a18df709c9f';
var Q7_NO_OPTION = 'b75c775446e3bb54-ce629a17df709c9e';

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

  var pdfBytes = await pdfDoc.save({ updateFieldAppearances: false });
  return Buffer.from(pdfBytes);
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
            model: 'claude-opus-4-20250514', max_tokens: 200, temperature: 0,
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

    // Build a minimal appearance stream that renders the text
    var textVal = String(updateMap[name2]).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    var streamContent = '/Tx BMC\nq\n1 1 ' + (width - 2) + ' ' + (height - 2) + ' re\nW\nn\nBT\n/Helv ' + fontSize + ' Tf\n0 g\n2 ' + Math.max(2, (height - fontSize) / 2) + ' Td\n(' + textVal + ') Tj\nET\nQ\nEMC';
    var streamBytes = new Uint8Array(Buffer.from(streamContent));
    var streamRef = pdfDoc.context.register(pdfDoc.context.stream(streamBytes, {
      '/Type': '/XObject', '/Subtype': '/Form',
      '/BBox': pdfDoc.context.obj([0, 0, width, height]),
      '/Resources': pdfDoc.context.obj({
        '/Font': pdfDoc.context.obj({
          '/Helv': pdfDoc.context.obj({
            '/Type': '/Font', '/Subtype': '/Type1', '/BaseFont': '/Helvetica'
          })
        })
      })
    }));

    // Set the appearance on the field widget
    var ap = field2.get(PDFName.of('AP'));
    if (!ap) {
      field2.set(PDFName.of('AP'), pdfDoc.context.obj({ '/N': streamRef }));
    } else {
      ap.set(PDFName.of('N'), streamRef);
    }
  }

  var pdfBytes = await pdfDoc.save({ updateFieldAppearances: false });
  return { buffer: Buffer.from(pdfBytes), amended: amended };
}

module.exports = { fillSppaQ7, extractAltSupervisorNames, amendSppaField, amendSppaFields, extractSppaFormFields, CONFLICT_DETAILS_TEXT };
