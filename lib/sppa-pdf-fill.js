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

module.exports = { fillSppaQ7, CONFLICT_DETAILS_TEXT };
