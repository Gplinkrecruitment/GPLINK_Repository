/* Australian GP build (WP-12, APP-27, walk-findings D6 and D7): what Support
 * shows a doctor who already holds Ahpra registration and works in Australia.
 *
 *   GPSupportAu.CATEGORIES      the "New ticket" categories (value, label)
 *   GPSupportAu.FAQ_ITEMS       the short answers under "Popular articles"
 *   GPSupportAu.HELP_ARTICLES   the longer articles
 *   GPSupportAu.ARTICLES_LABEL  the heading above them
 *
 * pages/messages.html loads this file only for a doctor on an Australian
 * pathway and then draws from these lists instead of its own (which are
 * about moving to Australia from another country and stay exactly as they
 * are for everyone else).
 *
 * Rules for the wording here: general information only. No legal advice, no
 * statement of what a regulator requires, no pay figures. Where a doctor
 * needs advice (a contract clause, a restraint), it says so and says who to
 * ask. Every word is checked by tests/au-wp12-banned-words.test.js.
 *
 * A category's `value` is one the server already accepts for a ticket
 * (Documents, AHPRA, Provider, Contract, Other): only the labels are new.
 */
(function (root) {
  'use strict';

  var CATEGORIES = [
    { value: 'Documents', label: 'Documents' },
    { value: 'AHPRA', label: 'My Ahpra registration details' },
    { value: 'Provider', label: 'Provider number or my new practice' },
    { value: 'Contract', label: 'Offer or contract' },
    { value: 'Other', label: 'Something else' }
  ];

  var FAQ_ITEMS = [
    {
      id: 'aufaq1', title: 'How GP Link works for a GP already in Australia',
      content: 'You browse confidential roles in the app, and apply for the ones you like. Your GP Link consultant introduces you to the practice, you meet them by video, and if they make an offer you review and sign it here. After that there is a short pre-start checklist, and then your first day.\n\nThere is no cost to you. The practice pays GP Link when you start.'
    },
    {
      id: 'aufaq2', title: 'Will my current practice find out?',
      content: 'We never contact your current practice without asking you first.\n\nA practice you apply to sees your profile only after you agree to share it with that practice for that role. If one of your referees works at your current practice, tell us, and we will check with you before we call them.'
    },
    {
      id: 'aufaq3', title: 'How do I upload a document?',
      content: 'Open My Documents, choose the document, then take a photo or pick a file from your device. We accept a photo or a PDF, up to 5 MB.\n\nOur team checks each document and tells you if anything needs another look.'
    },
    {
      id: 'aufaq4', title: 'What is the pre-start checklist?',
      content: 'It is the short list of things to finish between signing your contract and your first day: our check of your Ahpra registration on the public register, your indemnity certificate, a Medicare provider number for the new location, two referees, credentialing with the practice, giving notice, and a confirmed start date.\n\nEach item shows who is doing it: you, GP Link, or the practice. You will find it under Home once your placement is secured.'
    },
    {
      id: 'aufaq5', title: 'Who do I talk to?',
      content: 'Before you are placed, your GP Link consultant looks after you. After you sign, a small GP Link team sees you through the pre-start checklist.\n\nEither way, create a ticket here or reply to any message from us, and the right person will pick it up. We usually reply within one working day.'
    }
  ];

  var HELP_ARTICLES = [
    {
      id: 'au1',
      title: 'How GP Link works when you are already registered in Australia',
      tag: 'Getting started', tagBg: '#eff6ff', tagColor: '#1d4ed8',
      bg: 'linear-gradient(135deg, #1e3a8a, #3b82f6)', icon: 'stethoscope',
      desc: 'From browsing roles to your first day, step by step.',
      content: 'GP Link places GPs with general practices across Australia. If you already hold Ahpra registration and work here, the process is short.\n\n1. Tell us about you. You gave us your registration details, where you are now, your notice period and where you would like to work. Our team confirms your registration on the public Ahpra register.\n\n2. Browse and apply. Roles in the app are confidential: the practice is named once you are being put forward. Apply for the ones that suit you. There is a limit on how many applications you can have open at once, so practices know every introduction is one you want.\n\n3. Meet the practice. If the practice wants to meet you, you choose a time and we set up the video call.\n\n4. Offer and contract. If the practice makes an offer, you read it and sign it in the app. Take your time, and get your own advice if you want it.\n\n5. Pre-start. A short checklist takes you from signing to your first day.\n\nYou can message us at any point.'
    },
    {
      id: 'au2',
      title: 'Confidentiality: who sees what, and when',
      tag: 'Confidentiality', tagBg: '#ecfdf5', tagColor: '#047857',
      bg: 'linear-gradient(135deg, #064e3b, #10b981)', icon: 'shield',
      desc: 'Your current practice is never contacted without your say-so.',
      content: 'Looking at other roles while you are working is normal, and it is your business.\n\nWe never contact your current practice without asking you first.\n\nA practice sees your profile only after you agree to share it with that practice for that role. You are asked each time you apply.\n\nReferees: we ask you for two referees who have agreed to be contacted. If either works at your current practice, tell us when you add them. We will check with you before we get in touch with them.\n\nIf you would like us to hold off contacting anyone until a certain date, tell us in a message and we will note it on your file.'
    },
    {
      id: 'au3',
      title: 'Your pre-start checklist, item by item',
      tag: 'Pre-start', tagBg: '#fff7ed', tagColor: '#c2410c',
      bg: 'linear-gradient(135deg, #9a3412, #fb923c)', icon: 'clipboard',
      desc: 'What happens between signing and your first day, and who does each part.',
      content: 'Once your placement is secured, a checklist opens under Home. Each item shows its status and who is doing it.\n\nAhpra register check. We look you up on the public register. Nothing for you to do.\n\nNotice to your current practice. You give notice when you are ready, then tell us the date.\n\nStart date. We agree it with you and the practice once your notice period is known.\n\nIndemnity certificate. You upload a current certificate of currency from your indemnity insurer.\n\nMedicare provider number. Your new practice location needs its own provider number. You apply, and tell us the number when it arrives.\n\nReference checks. You give us two referees. We take the references.\n\nPractice credentialing. We send your credentialing pack to the practice.\n\nOther documents. Anything else on the list shows what to upload.\n\nIf an item is stuck, message us and we will chase it.'
    },
    {
      id: 'au4',
      title: 'A provider number for your new location',
      tag: 'Provider number', tagBg: '#f5f3ff', tagColor: '#6d28d9',
      bg: 'linear-gradient(135deg, #4c1d95, #8b5cf6)', icon: 'folder',
      desc: 'What we ask you for, and where to enter it.',
      content: 'Your new practice location needs its own provider number. Services Australia issues provider numbers, and you apply to them.\n\nIn the app, open the Medicare provider number step. It asks for two things:\n\nThe numbers you already hold. Add your existing provider numbers and, if you have one, your prescriber number, so we have them on file.\n\nThe number for your new location. When it is issued, enter it, and we record it on your file.\n\nWe cannot tell you how long an application will take, and we are not able to advise on your individual circumstances with Services Australia. If something about your situation is unusual, tell us early so we can plan the start date around it.'
    },
    {
      id: 'au5',
      title: 'Changing practices: notice periods and restraint clauses',
      tag: 'Changing practices', tagBg: '#fef2f2', tagColor: '#b91c1c',
      bg: 'linear-gradient(135deg, #7f1d1d, #ef4444)', icon: 'calendar',
      desc: 'General information to help you plan. Not legal advice.',
      content: 'This is general information, not legal advice. Your own contract is what counts.\n\nNotice periods. Most agreements between a GP and a practice set out how much notice either side must give. Check yours before you agree a start date, and tell us your notice period so the date we propose is realistic.\n\nRestraint clauses. Some agreements include a restraint: a clause about where you may work, and for how long, after you leave. They vary a great deal. If your agreement has one, read it carefully and tell us what it says before you apply for a role nearby, so nobody is surprised later.\n\nGetting advice. Whether a clause applies to you, and what it means in practice, is a legal question. We are not able to answer it. Your indemnity insurer or a lawyer who works with medical contracts can.\n\nPatients and records. How you tell patients you are moving, and what happens to records, is usually covered by your current agreement and the practice\'s policies. Ask your practice manager.\n\nWe will never contact your current practice without asking you first.'
    }
  ];

  var api = {
    CATEGORIES: CATEGORIES,
    FAQ_ITEMS: FAQ_ITEMS,
    HELP_ARTICLES: HELP_ARTICLES,
    ARTICLES_LABEL: 'Working with GP Link',
    SUBJECT_PLACEHOLDER: 'E.g. A question about my start date'
  };

  root.GPSupportAu = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
