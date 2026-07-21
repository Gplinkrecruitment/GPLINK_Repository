// Per-country GP document requirements — the single server-side source of truth.
//
// These lists were reconciled faithfully from the (previously client-only)
// COUNTRY_DOCS config in pages/my-documents.html: every institution-sent and
// GP-prepared document type that any country showed there is preserved here,
// including the ordered position, labels, action labels and the "Show me how"
// help content. The page now consumes GET /api/gp/document-requirements and
// keeps only a minimal embedded fallback for when that fetch fails.
//
// Country codes are lowercase 'uk' | 'ie' | 'nz' (the same buckets the rest of
// the server uses via registration_country || gp_selected_country). An unknown
// country must be treated as UNSUPPORTED by callers — never silently mapped to
// the UK list.

'use strict';

const SUPPORTED_DOCUMENT_REQUIREMENT_COUNTRIES = ['uk', 'ie', 'nz'];

// Shared "Show me how" content -------------------------------------------------

const CV_HELP = {
  title: 'CV',
  steps: [
    'Your CV must be signed and dated, and cover your full work practice/history, any gaps, your registration history and a declaration.',
    '<strong>Work practice/history</strong> — include the following details of your current and previous positions:<ul><li>Dates (for example 30/06/2021 – 30/06/2023)</li><li>Position(s) — title</li><li>Facility (including name, address and contact details — i.e. city, state, country)</li><li>Responsibilities (including whether the position was full-time or part-time; if part-time, include hours of work per week)</li><li>Internship and observership (include details of internship rotations and any periods of observership, in date order)</li></ul>',
    '<strong>Gaps in work practice/history</strong> — provide an explanation of any period since obtaining your professional qualifications where you have not practised, and the reasons (e.g. undertaking study, travel, family commitment).',
    '<strong>Registration history</strong> — provide a list of locations and registration authorities/boards/jurisdictions:<ul><li>where you are currently registered to practise, and your registration number</li><li>where you have been previously registered to practise, and your registration number (if known)</li><li>where you have applied for registration and that application remains under consideration</li></ul>',
    '<strong>Declaration</strong> — on your CV you must write: ‘The curriculum vitae is true and correct as at (insert date)’, then sign and date it. You do not need to get the CV certified — just write this statement and sign it. Your National Board will only accept a CV with this statement on it.',
    'Also attach certified copies of any results or performance reports from bridging courses, skills assessment or observership (as applicable) that you have stated in the CV.',
    'Upload your signed and dated CV'
  ],
  reminder: 'Reminder: your CV will not be accepted unless it includes the signed and dated declaration statement.'
};

const CRIMINAL_HISTORY_STEPS = [
  'Complete your international criminal history check through <a href="https://www.fit2work.com.au/PreEmployment/GeneralBasicDetails?id=q8Uuw%2BuklTU%3D&amp;_gl=1*ckbmax*_gcl_au*NjY2MzAyMDA3LjE3NzE3NjkwMjU.*_ga*ODA4ODU4NTIuMTc3MTc2OTAyNg..*_ga_0BTJRVTY8V*czE3Nzc1NTcwODQkbzUkZzAkdDE3Nzc1NTcwODQkajYwJGwwJGgw*_ga_WM6YQZ40M2*czE3Nzc1NTcwODQkbzUkZzAkdDE3Nzc1NTcwODQkajYwJGwwJGgxNzk3MjAwOTU0" target="_blank" rel="noopener noreferrer">Fit2Work</a>',
  'Look out for an email from Fit2Work that will include your reference page. The reference page will include a reference number starting with <strong>FIT</strong> followed by 7 digits (e.g. <strong>FIT1234567</strong>). Enter this reference number below before marking as requested.'
];

function criminalHistoryItem() {
  return {
    key: 'criminal_history',
    title: 'Criminal History Check',
    actionLabel: 'Mark Requested',
    help: {
      title: 'Criminal History Check',
      steps: CRIMINAL_HISTORY_STEPS.slice()
    }
  };
}

// The country config -----------------------------------------------------------

const DOCUMENT_REQUIREMENTS = {
  uk: {
    label: 'United Kingdom',
    institution: [
      {
        key: 'certificate_good_standing',
        title: 'Certificate of Good Standing',
        actionLabel: 'Mark Requested',
        help: {
          title: 'Certificate of Good Standing',
          steps: [
            'Log in to your <a href="https://extgenmedcouncil.b2clogin.com/extgenmedcouncil.onmicrosoft.com/b2c_1a_usersigninormigrategmconline/oauth2/v2.0/authorize?client_id=1304d06d-0b67-4d06-9abd-e03aaef62a88&redirect_uri=https%3A%2F%2Fwww.gmc-uk.org%2Fqitm%2Fsignin-oidc&response_type=id_token&scope=openid%20profile&response_mode=form_post&nonce=639088171193672580.ZjQwODcyZDgtNTAxOC00YmM2LWE4ZGUtM2I2NWUxNjE0MTVhNzJmY2YzMmQtNTg5Zi00NWRhLTgzYWEtNGMwYWZmMTFjZjg0&client_info=1&x-client-brkrver=IDWeb.1.24.0.0&state=CfDJ8CCFNphTI2xLiogAzC0YsAyIgiiJHlbcbo8KWD0yCcvLYHNZ1xxff35Gjym3wF68p0qnWcVa14sNBtztLdjKu9LyjSCebUIDBFdIvp2xvEUn086Tmqz1yP1ib7R7GaecxE6Aqb9w32l4XIh2x-7FLDYD92INc-Py--FWGS6YBTk1W1cUGoSi79jwFYlY7Ikf-chZf7yqV-3iVm-m_ZXnD-0rwEyDlyUHXfgM5eLMvcXvP_zNSmyKOLvzfe3bHddEmWStUY2QOXtCHxHYqD8womPvW29r7VGUM81fT1hbaj3xUprxuVhINsQTRA9_eIT8me26YGF4Io1VXbZEk4ObR8fDjVhTB38PUd8HiyHdALY2xv5qz5arVs3nzap_Ttoorg&x-client-SKU=ID_NETSTANDARD2_0&x-client-ver=6.17.0.0">GMC Online account</a>',
            'In the left hand menu choose "My registration"',
            'Then open "My CCPS requests"',
            'Request the certificate to be sent directly to Ahpra',
            'Ask the GMC to email it directly to Ahpra at <a href="mailto:COGS@ahpra.gov.au">COGS@ahpra.gov.au</a>'
          ],
          reminder: 'Reminder: the GMC must send this directly to Ahpra (COGS@ahpra.gov.au), not to you.'
        }
      },
      {
        key: 'confirmation_training',
        title: 'Confirmation of Training',
        actionLabel: 'Mark Requested',
        help: {
          title: 'Confirmation of Training',
          steps: [
            '<a href="mailto:portfolio@gmc-uk.org?subject=Request%20for%20Confirmation%20of%20Training&body=Dear%20GMC%20Portfolio%20Team%2C%0A%0AI%20am%20writing%20to%20request%20confirmation%20of%20my%20specialist%20%2F%20GP%20training%20posts.%20I%20require%20this%20documentation%20for%20my%20application%20to%20the%20Australian%20Health%20Practitioner%20Regulation%20Agency%20(Ahpra).%0A%0APlease%20advise%20on%20the%20next%20steps%20and%20any%20forms%20I%20need%20to%20complete.%0A%0AKind%20regards">Email portfolio@gmc-uk.org</a>',
            'State that you require confirmation of your specialist / GP training posts',
            'GMC will review the request and send you an application form to complete',
            'Complete the form and return it as instructed',
            'Ask the GMC to send the confirmation of training directly to AHPRA by email to <a href="mailto:registration18@ahpra.gov.au">registration18@ahpra.gov.au</a>'
          ],
          reminder: 'Reminder: the confirmation of training must be sent by the GMC directly to Ahpra (registration18@ahpra.gov.au), not to you.'
        }
      },
      criminalHistoryItem()
    ],
    prepared: [
      {
        key: 'primary_medical_degree',
        title: 'Certified copy of Primary Medical Degree (MBBS/MBChB)',
        help: {
          title: 'Primary Medical Degree',
          steps: ['Upload a certified copy of your primary medical degree'],
          certNote: true
        }
      },
      {
        key: 'mrcgp_certified',
        title: 'Certified copy of MRCGP',
        help: {
          title: 'MRCGP',
          steps: ['Upload a certified copy of your MRCGP certificate'],
          certNote: true
        }
      },
      {
        key: 'cct_certified',
        title: 'Certified copy of CCT (General Practice) issued by the General Medical Council or PMETB',
        help: {
          title: 'CCT',
          steps: ['Upload a certified copy of your CCT certificate issued by the GMC or PMETB'],
          certNote: true
        }
      },
      {
        key: 'cv_signed_dated',
        title: 'CV (Signed and dated)',
        help: CV_HELP
      }
    ]
  },
  ie: {
    label: 'Ireland',
    institution: [
      {
        key: 'certificate_good_standing',
        title: 'Certificate of Good Standing / Registration Status',
        actionLabel: 'Mark Requested',
        help: {
          title: 'Certificate of Good Standing / Registration Status',
          steps: [
            'Log in to the <a href="https://portal.medicalcouncil.ie/html/login.html?ui_locales=en/1000" target="_blank" rel="noopener noreferrer">Medical Council of Ireland Doctors Portal</a>.',
            'Request a Certificate of Good Standing / Current Professional Status.',
            'Select the recipient as Australian Health Practitioner Regulation Agency / Medical Board of Australia.',
            'Ask MCI to send it directly to AHPRA at <a href="mailto:COGS@ahpra.gov.au">COGS@ahpra.gov.au</a>.'
          ],
          reminder: 'Reminder: MCI must send this directly to Ahpra (COGS@ahpra.gov.au), not to you.'
        }
      },
      criminalHistoryItem()
    ],
    prepared: [
      {
        key: 'primary_medical_degree',
        title: 'Certified copy of Primary Medical Degree',
        help: {
          title: 'Primary Medical Degree',
          steps: ['Upload a certified copy of your primary medical degree'],
          certNote: true
        }
      },
      {
        key: 'micgp_certified',
        title: 'Certified copy of MICGP',
        help: {
          title: 'MICGP',
          steps: [
            'Upload a certified copy of your MICGP certificate',
            'If you do not have a copy, request a re-issue from ICGP Membership Services'
          ],
          certNote: true
        }
      },
      {
        key: 'cscst_certified',
        title: 'Certified copy of CSCST',
        help: {
          title: 'CSCST',
          steps: [
            'Upload a certified copy of your CSCST',
            'If needed, request a re-issue from ICGP Membership Services'
          ],
          certNote: true
        }
      },
      {
        key: 'icgp_confirmation_letter',
        title: 'Certified copy of ICGP Confirmation Letter',
        help: {
          title: 'ICGP Confirmation Letter',
          steps: [
            'Email the Irish College of General Practitioners — ICGP at <a href="mailto:info@icgp.ie">info@icgp.ie</a>.',
            'Request an ICGP confirmation letter for the AHPRA expedited specialist pathway.',
            'Ask ICGP to confirm:<ul><li>you hold MICGP</li><li>you were awarded CSCST</li><li>the date your CSCST was awarded</li><li>your training was completed under an ICGP curriculum from 2009 onwards</li><li>your training was completed through the 4-year GP training programme, Recognition of Prior Learning, or an approved GP training scheme in Ireland</li></ul>',
            'Include:<ul><li>your full name</li><li>your date of birth</li><li>your ICGP number, if known</li><li>your Medical Council of Ireland registration number</li><li>the date your MICGP / CSCST was awarded, if known</li><li>your AHPRA reference number, if available</li></ul>',
            'Ask ICGP to provide the letter as a PDF by email.',
            'Once you receive the PDF, have it certified as a true copy of the original before uploading.'
          ],
          certNote: true,
          reminder: 'This is the key supporting letter for Irish GPs.'
        }
      },
      {
        key: 'cv_signed_dated',
        title: 'CV (Signed and dated)',
        help: CV_HELP
      }
    ]
  },
  nz: {
    label: 'New Zealand',
    institution: [
      {
        key: 'certificate_good_standing',
        title: 'Certificate of Good Standing / Registration Status',
        actionLabel: 'Mark Requested',
        help: {
          title: 'Certificate of Good Standing / Registration Status',
          steps: [
            'Log in to <a href="https://mymcnz.org.nz/Account/LogOn?ReturnUrl=%2f" target="_blank" rel="noopener noreferrer">myMCNZ</a>',
            'Request a Certificate of Professional Status (COPS)',
            'Select / send it to Australian Health Practitioner Regulation Agency / Medical Board of Australia',
            'Ask MCNZ to email it directly to AHPRA at <a href="mailto:COGS@ahpra.gov.au">COGS@ahpra.gov.au</a>'
          ]
        }
      },
      criminalHistoryItem()
    ],
    prepared: [
      {
        key: 'primary_medical_degree',
        title: 'Certified copy of Primary Medical Degree',
        help: {
          title: 'Primary Medical Degree',
          steps: ['Upload a certified copy of your primary medical degree'],
          certNote: true
        }
      },
      {
        key: 'frnzcgp_certified',
        title: 'Certified copy of FRNZCGP',
        help: {
          title: 'FRNZCGP',
          steps: [
            'Upload a certified copy of your FRNZCGP certificate',
            'If needed, contact RNZCGP for replacement or confirmation'
          ],
          certNote: true
        }
      },
      {
        key: 'rnzcgp_confirmation_letter',
        title: 'Certified copy of RNZCGP Confirmation Letter',
        help: {
          title: 'RNZCGP Confirmation Letter',
          steps: [
            'Email the RNZCGP Fellowship Team at <a href="mailto:fellowship@rnzcgp.org.nz">fellowship@rnzcgp.org.nz</a>',
            'Ask RNZCGP to issue a letter confirming:<ul><li>you hold Fellowship of the Royal New Zealand College of General Practitioners — FRNZCGP</li><li>the date your FRNZCGP was awarded</li><li>that your FRNZCGP was awarded from 2012 onwards</li><li>that you completed the General Practice Education Programme — GPEP</li><li>that your GPEP was completed under the RNZCGP curriculum</li></ul>',
            'Ask that they return the letter as a PDF',
            'Once you receive the PDF, have it certified as a true copy of the original before uploading.'
          ],
          certNote: true
        }
      },
      {
        key: 'cv_signed_dated',
        title: 'CV (Signed and dated)',
        help: CV_HELP
      }
    ]
  }
};

// The Fit2Work ICHC step rewrite the page used to apply at load time — the
// served config carries the FINAL steps so the page can render it verbatim.
const ICHC_EXAMPLE_STEP_HTML = 'See what the page looks like: <a href="/documents/fit2work-ichc-example.pdf" target="_blank" rel="noopener noreferrer">view a sample Fit2Work ICHC reference page</a>. This is only an example — you must upload your own page, not this sample.';
Object.keys(DOCUMENT_REQUIREMENTS).forEach(function (c) {
  (DOCUMENT_REQUIREMENTS[c].institution || []).forEach(function (d) {
    if (d.key === 'criminal_history' && d.help && Array.isArray(d.help.steps)
        && d.help.steps.indexOf(ICHC_EXAMPLE_STEP_HTML) === -1) {
      d.help.steps = d.help.steps
        .map(function (s) {
          return /Enter this reference number below/.test(s)
            ? 'When your check is complete, Fit2Work emails you a <strong>reference page</strong> (PDF). Download it and upload it below — our system reads your <strong>FIT</strong> number from it automatically.'
            : s;
        })
        .concat([ICHC_EXAMPLE_STEP_HTML]);
    }
  });
});

// Same normalization the rest of the server uses (normalizeDocumentCountry in
// server.js): lowercase uk/ie/nz plus the common aliases. Returns '' for any
// unknown value — callers must surface that as "unsupported", never default UK.
function normalizeRequirementCountry(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'uk' || raw === 'gb' || raw === 'united kingdom') return 'uk';
  if (raw === 'ie' || raw === 'ireland') return 'ie';
  if (raw === 'nz' || raw === 'new zealand') return 'nz';
  return '';
}

// Returns the config for a supported country, or null when unsupported.
function getDocumentRequirements(countryRaw) {
  const country = normalizeRequirementCountry(countryRaw);
  if (!country || !DOCUMENT_REQUIREMENTS[country]) return null;
  return { country, requirements: DOCUMENT_REQUIREMENTS[country] };
}

module.exports = {
  SUPPORTED_DOCUMENT_REQUIREMENT_COUNTRIES,
  DOCUMENT_REQUIREMENTS,
  normalizeRequirementCountry,
  getDocumentRequirements
};
