# GP Link — What Each AI Scan Looks For

---

## SCAN 1: Qualification Verification (Images only)
**Endpoint:** `POST /api/ai/verify-qualification`
**Model:** Claude Sonnet 4.6 (vision)
**Trigger:** User uploads an IMAGE for any certNote document via camera or file upload

### What it checks:
1. **Is this the correct document type?** Looks for the correct issuing body:

| Document | What AI looks for |
|----------|------------------|
| **MRCGP** | "Royal College of General Practitioners" (UK) |
| **CCT** | "General Medical Council" or "PMETB" (UK) |
| **Confirmation of Training** | Letter from GMC confirming specialist/GP training posts |
| **MICGP** | "Irish College of General Practitioners" (Ireland) |
| **CSCST** | Certificate issued by Irish medical authorities |
| **ICGP Confirmation Letter** | Letter from ICGP confirming qualification under ICGP curriculum |
| **FRNZCGP** | "Royal New Zealand College of General Practitioners" (New Zealand) |
| **RNZCGP Confirmation Letter** | Letter from RNZCGP confirming fellowship under RNZCGP curriculum after GPEP |
| **Primary Medical Degree** | Any recognized medical degree (MBBS, MBChB, MB BCh BAO, MD, BMed, etc.) from any accredited university worldwide |
| **Certificate of Good Standing** | Issued by relevant medical regulatory body (GMC, IMC, MCNZ, etc.) |
| **Criminal History Check** | Police clearance, DBS check, Fit2Work report, or equivalent |
| **CV (Signed and dated)** | Doctor's curriculum vitae — must be signed and dated |

2. **Date validation:**
   - UK: Must be from August 2007 or later
   - Ireland: Must be from 2009 or later
   - New Zealand: Must be from 2010 or later
   - Primary Medical Degrees: Date does not matter

3. **Name on document** — extracted and fuzzy-matched against user profile

4. **Legibility** — is the document readable?

### Pass/Fail:
- **PASS:** Correct document type, valid date, legible → attached with green tick
- **FAIL:** Wrong document type, wrong date, illegible → red cross popup, NOT attached

---

## SCAN 2: Certification Verification (Images only)
**Endpoint:** `POST /api/ai/verify-certification`
**Model:** Claude Sonnet 4.6 (vision)
**Trigger:** User uploads an IMAGE for a certNote document (certified copy required)

### What it checks — certification markings:

| # | Element | What AI looks for |
|---|---------|------------------|
| 1 | **Certification Statement** | Words like "I certify this to be a true copy of the original" or similar |
| 2 | **Signature** | A handwritten signature from the certifier |
| 3 | **Certifier's Name** | The certifier's printed full name |
| 4 | **Date** | The date of certification |
| 5 | **Occupation/Profession** | Solicitor, notary, JP, etc. |
| 6 | **Contact Details** | Phone number or registration/profession number |
| 7 | **Stamp/Seal** | An official stamp or seal (not always required) |

### Pass/Fail:
- **PASS (lenient):** At least certification statement + signature + name visible → "Certified" green badge
- **FAIL:** Original certificate with no certification markings, or missing key elements → red cross, NOT attached
- **Note:** An original certificate WITHOUT certification markings counts as NOT certified

---

## SCAN 3: Document Classification (Images + PDFs)
**Endpoint:** `POST /api/ai/classify-document`
**Model:** Claude Sonnet 4.6 (vision)
**Trigger:** User uploads a PDF or non-image file for a certNote document (also used for images on desktop)

### What it checks:
The AI reads the actual content of the document (not just the filename) and determines whether it matches what the user claims it is. It knows about all valid document types:

| Document | What AI looks for in the content |
|----------|--------------------------------|
| **Primary Medical Degree** | MBBS, MBChB, MB BCh BAO, MD, BMed certificate from a university/medical school |
| **MRCGP** | Certificate from Royal College of General Practitioners (UK) |
| **CCT** | Certificate of Completion of Training from GMC or PMETB (UK) |
| **MICGP** | Certificate from Irish College of General Practitioners |
| **CSCST** | Certificate of Satisfactory Completion of Specialist Training (Ireland) |
| **ICGP Confirmation Letter** | Letter from ICGP confirming qualification |
| **FRNZCGP** | Fellowship certificate from Royal New Zealand College of GPs |
| **RNZCGP Confirmation Letter** | Letter from RNZCGP confirming fellowship |
| **Certificate of Good Standing** | Registration status document from a medical regulatory body |
| **Criminal History Check** | Police clearance, DBS check, Fit2Work report, or equivalent |
| **CV (Signed and dated)** | A doctor's curriculum vitae / resume |
| **Confirmation of Training** | Letter from GMC or equivalent confirming training posts |

### Pass/Fail:
- **PASS:** AI confirms the document matches the expected type → attached as "Under Review" (certification checked manually later)
- **FAIL:** AI identifies it as a different document → red cross "Wrong Document" popup showing what it actually is, NOT attached

---

## Summary: What happens per file type

| File Type | Scan 1 (Qualification) | Scan 2 (Certification) | Scan 3 (Classification) |
|-----------|----------------------|----------------------|------------------------|
| **Image (JPG, PNG, WEBP)** | YES — checks document type, date, name | YES — checks certification markings | NO (Scans 1+2 cover it) |
| **PDF / other files** | NO | NO | YES — Claude vision reads PDF content and verifies document type |

---

## How to test

1. **Upload correct image** → should pass both Scan 1 and Scan 2
2. **Upload wrong image** (e.g., driver's licence for MRCGP slot) → Scan 1 fails, red cross
3. **Upload uncertified image** (original certificate, no solicitor stamp) → Scan 2 fails, red cross
4. **Upload correct PDF** (e.g., actual MRCGP certificate PDF) → Scan 3 passes, "Under Review"
5. **Upload wrong PDF** (e.g., AHPRA application form for Primary Medical Degree slot) → Scan 3 fails, "Wrong Document" with explanation of what the document actually is
