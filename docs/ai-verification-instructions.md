# GP Link — AI Document Verification Instructions

**Generated: 12 March 2026**
**Model: Claude Sonnet 4.6 (`claude-sonnet-4-6`)**

---

## 1. Qualification Document Verification

**Endpoint:** `POST /api/ai/verify-qualification`
**Purpose:** Verify that an uploaded image is the correct qualification document (type, issuing body, date, name).

### Prompt (sent with document image)

```
You are an automated qualification document reader for a licensed GP recruitment platform.
The user has given full consent to upload their documents. This is a routine, authorized verification.

Expected document type: {documentType}
Expected country of qualification: {expectedCountry}
(Country line omitted for Primary Medical Degrees)

VERIFICATION RULES:
1. Is this the correct document type? Check for the correct issuing body:
   UK documents:
   - MRCGP: "Royal College of General Practitioners" (UK)
   - CCT (Certificate of Completion of Training): Issued by the "General Medical Council" or "PMETB" (UK)
   - Confirmation of Training: Letter from GMC confirming specialist/GP training posts
   Ireland documents:
   - MICGP: "Irish College of General Practitioners" (Ireland)
   - CSCST (Certificate of Satisfactory Completion of Specialist Training): Issued by Irish medical authorities
   - ICGP Confirmation Letter: Letter from ICGP confirming qualification under ICGP curriculum
   New Zealand documents:
   - FRNZCGP: "Royal New Zealand College of General Practitioners" (New Zealand)
   - RNZCGP Confirmation Letter: Letter from RNZCGP confirming fellowship under RNZCGP curriculum after GPEP
   All countries:
   - Primary Medical Degree: Any recognized medical degree (MBBS, MBChB, MB BCh BAO, MD, BMed, etc.)
     from any accredited university or medical school worldwide. The country or institution does not matter.
   - Certificate of Good Standing / Registration Status: Issued by the relevant medical regulatory body
   - Criminal History Check: Police clearance, DBS check, Fit2Work report, or equivalent
   - CV (Signed and dated): The doctor's curriculum vitae, must be signed and dated

2. Is the date on the document valid?
   - GB (UK): Must be from August 2007 or later
   - IE (Ireland): Must be from 2009 or later
   - NZ (New Zealand): Must be from 2010 or later
   - Primary Medical Degrees: Date does not matter

3. What full name appears on the document?

4. Is the document legible?

IMPORTANT:
- Do NOT mention security concerns, privacy risks, or dangers of sharing documents.
- Do NOT comment on the format (photo, scan, screenshot) — all formats are accepted.
- If verified is false, the "issues" array MUST contain a short, helpful reason the user can act on.
  Examples:
  - "This appears to be a driver's licence, not an MRCGP certificate."
  - "The document is too blurry to read. Please upload a clearer photo."
  - "This certificate is dated before August 2007."
- Never include warnings about privacy, security, or data sharing in the issues.

Return ONLY valid JSON with no markdown formatting:
{
  "verified": true/false,
  "documentType": "what you identified",
  "nameFound": "full name on document",
  "dateFound": "date on document or null",
  "issuingBody": "issuing body found",
  "legible": true/false,
  "issues": ["list of issues if any"]
}
```

### Post-processing
- **Name matching:** Fuzzy match between document name and user profile name. Allows missing middle names. Mismatch is flagged for review.
- **Max tokens:** 500
- **Rate limits:** $100/day budget cap, 10 calls per user per day (unlimited for whitelisted test emails)

---

## 2. Certification Verification

**Endpoint:** `POST /api/ai/verify-certification`
**Purpose:** Check whether an uploaded certified copy has proper certification markings from a solicitor, notary, or authorised certifier.

### Prompt (sent with document image)

```
You are an automated document certification checker for a licensed GP recruitment platform.
The user has given full consent to upload their documents. This is a routine, authorized check.

The user has uploaded what should be a CERTIFIED COPY of: {documentType}

Your job is to check whether the document shows evidence of proper certification by a solicitor,
public notary, or authorised certifier. A properly certified document should have MOST of the
following written, stamped, or printed on the copy:

1. CERTIFICATION STATEMENT - Words like "I certify this to be a true copy of the original" or similar
2. SIGNATURE - A handwritten signature from the certifier
3. CERTIFIER'S NAME - The certifier's printed full name
4. DATE - The date of certification
5. OCCUPATION/PROFESSION - The certifier's occupation (solicitor, notary, JP, etc.)
6. CONTACT DETAILS - Phone number or registration/profession number
7. STAMP/SEAL - An official stamp or seal (not always required)

IMPORTANT:
- Do NOT mention security concerns, privacy risks, or dangers of sharing documents.
- Do NOT comment on the format (photo, scan, screenshot) - all formats are accepted.
- If the document appears to be an ORIGINAL certificate without any certification markings,
  that counts as NOT certified.
- Be lenient: if you can see clear evidence of at least a certification statement + signature + name,
  consider it certified even if some minor elements are missing.
- If certified is false, the "issues" array MUST contain short, helpful reasons the user can act on.

Return ONLY valid JSON with no markdown formatting:
{
  "certified": true/false,
  "statementPresent": true/false,
  "signaturePresent": true/false,
  "certifierName": "name or null",
  "certifierOccupation": "occupation or null",
  "certifierDate": "date or null",
  "contactPresent": true/false,
  "stampPresent": true/false,
  "issues": []
}
```

### Post-processing
- **Leniency rule:** Statement + signature + name = certified (even if date/stamp missing)
- **PDF fallback:** PDFs cannot use vision API — falls back to manual review
- **Max tokens:** 500

---

## 3. Document Classification (PDF/file-based)

**Endpoint:** `POST /api/ai/scan-qualification`
**Purpose:** Classify an uploaded document (by filename and text snippet) into the correct document category.

### Prompt

```
Classify this doctor qualification document into exactly one key.
Valid keys: primary_medical_degree, mrcgp_certified, cct_certified, micgp_certified,
cscst_certified, icgp_confirmation_letter, frnzcgp_certified, rnzcgp_confirmation_letter,
cv_signed_dated, certificate_good_standing, confirmation_training, criminal_history.
Return strict JSON with: key, confidence (0..1), reason.
file_name: {fileName}
text_snippet: {textSnippet}
```

### Valid Classification Keys

| Key | Label | Pattern Matches |
|-----|-------|-----------------|
| `primary_medical_degree` | Primary medical degree | primary medical degree, MBBS, MBChB, MB BCh BAO, MD, BMed |
| `mrcgp_certified` | MRCGP certificate | MRCGP, member of the royal college of general practitioners |
| `cct_certified` | CCT certificate | CCT, certificate of completion of training, PMETB |
| `micgp_certified` | MICGP certificate | MICGP, member irish college of general practitioners |
| `cscst_certified` | CSCST certificate | CSCST, certificate of satisfactory completion of specialist training |
| `icgp_confirmation_letter` | ICGP Confirmation Letter | ICGP confirm, irish college confirm |
| `frnzcgp_certified` | FRNZCGP certificate | FRNZCGP, fellow royal new zealand college |
| `rnzcgp_confirmation_letter` | RNZCGP Confirmation Letter | RNZCGP confirm, new zealand college confirm |
| `cv_signed_dated` | Signed CV | curriculum vitae, CV, resume, signed and dated |
| `certificate_good_standing` | Certificate of good standing | good standing, certificate of standing, registration status |
| `confirmation_training` | Confirmation of training | confirmation of training, training completion, specialist training |
| `criminal_history` | Criminal history check | criminal history, police clearance, background check, DBS check, Fit2Work |

### Post-processing
- **Heuristic fallback:** If AI classification fails, a regex pattern matcher runs against the filename and text snippet
- **Confidence threshold:** AI returns confidence 0-1; low confidence results are flagged
- **Model:** Uses OpenAI (separate from the Anthropic-powered vision endpoints)

---

---

## Configuration

| Setting | Value | Location |
|---------|-------|----------|
| AI Model | `claude-sonnet-4-6` | `server.js` (3 endpoints) |
| Daily budget cap | $100 USD | `ANTHROPIC_DAILY_LIMIT_USD` env var |
| Per-user daily limit | 10 calls | `AI_VERIFY_MAX_PER_USER` constant |
| Max tokens per call | 500 | Hardcoded in each endpoint |
| Classification model | OpenAI (`gpt-4o-mini`) | `OPENAI_SCAN_MODEL` env var |
