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
  var pdfBytes = await pdfDoc.save({ updateFieldAppearances: false });
  return Buffer.from(pdfBytes);
}

/**
 * Extract all text form field names and values from an SPPA-00 PDF.
 * Returns an array of { name, value, type } for rendering as an editable form.
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
        value = value.replace(/^\(|\)$/g, '');
      }
      // Only include text fields (skip buttons/signatures)
      if (ft === '/Tx' && name && value) {
        fields.push({ name: name, value: value.trim() });
      }
    }
  } catch (err) {
    console.error('[SPPA] extractSppaFormFields error:', err.message);
  }
  return fields;
}

/**
 * Amend multiple fields on an SPPA-00 PDF at once.
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
    if (updateMap.hasOwnProperty(name)) {
      field.set(PDFName.of('V'), PDFString.of(String(updateMap[name])));
      amended++;
    }
  }

  var pdfBytes = await pdfDoc.save({ updateFieldAppearances: false });
  return { buffer: Buffer.from(pdfBytes), amended: amended };
}

module.exports = { fillSppaQ7, extractAltSupervisorNames, amendSppaField, amendSppaFields, extractSppaFormFields, CONFLICT_DETAILS_TEXT };
