# PDF.js Inline SPPA Editor — Design Spec

## Goal

Embed a visual PDF editor in the admin dashboard using Mozilla's PDF.js. The RSO clicks "Edit SPPA-00" and sees the actual PDF pages rendered in the browser with interactive form fields overlaid. They edit fields directly on the document (like DocHub/Lumin PDF), then click "Save & Send to AHPRA."

## Why

The current "Edit SPPA-00 Fields" approach shows raw field names in text inputs — it works but doesn't feel like editing the document. The RSO needs to see the PDF to understand what they're changing.

## Architecture

### Components

1. **PDF.js viewer page** — A standalone HTML page (`pages/pdf-editor.html`) that loads PDF.js, renders the PDF with form fields, and communicates with the parent admin page via `postMessage`.

2. **Admin integration** — When the RSO clicks "Edit SPPA-00", a modal/fullscreen overlay opens with the PDF editor in an iframe. After editing, the iframe sends the modified field values back to the parent.

3. **Server-side save** — The parent page sends the field updates to `/api/admin/va/task/:id/sppa-save-fields` (already exists), which uses pdf-lib to amend the PDF, upload to Drive, and deliver to MyDocuments.

### Flow

```
RSO clicks "Edit SPPA-00"
  → Opens modal with iframe to /pages/pdf-editor.html?taskId=X
  → pdf-editor.html fetches the SPPA PDF from /api/admin/va/task/:id/sppa-pdf
  → PDF.js renders all pages with AnnotationLayer (form fields become editable HTML inputs)
  → RSO edits fields directly on the rendered pages
  → RSO clicks "Save" button in the editor
  → Editor extracts all field values from the AnnotationLayer
  → postMessage({ type: 'sppa-fields-saved', fields: [{name, value}, ...] }) to parent
  → Parent calls /api/admin/va/task/:id/sppa-save-fields with the changes
  → Server amends PDF via pdf-lib, uploads to Drive, delivers to MyDocuments
  → Parent closes modal, refreshes task
```

### PDF.js Setup

- Use PDF.js from CDN: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.x.x/pdf.min.mjs`
- Need both `pdf.min.mjs` (core) and `pdf.worker.min.mjs` (worker)
- Need `pdf_viewer.mjs` + `pdf_viewer.css` from the viewer build for `AnnotationLayer` support
- PDF.js AnnotationLayer automatically renders form fields as HTML `<input>` elements positioned over the PDF canvas

### Key Technical Details

**Rendering with form fields:**
```javascript
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { AnnotationLayer } from 'pdfjs-dist/web/pdf_viewer';

GlobalWorkerOptions.workerSrc = 'pdf.worker.min.mjs';

const pdf = await getDocument({ data: pdfBytes }).promise;
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  const viewport = page.getViewport({ scale: 1.5 });
  
  // Render page to canvas
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  
  // Render annotation layer (form fields)
  const annotations = await page.getAnnotations();
  const annotDiv = document.createElement('div');
  annotDiv.className = 'annotationLayer';
  AnnotationLayer.render({
    viewport, div: annotDiv, annotations,
    page, linkService: null, renderForms: true
  });
  
  container.appendChild(canvas);
  container.appendChild(annotDiv);
}
```

**Extracting field values after editing:**
```javascript
function extractFieldValues() {
  const fields = [];
  document.querySelectorAll('.annotationLayer input, .annotationLayer textarea, .annotationLayer select').forEach(el => {
    const name = el.getAttribute('data-annotation-id') || el.name;
    // Map annotation IDs back to field names using the annotations data
    fields.push({ name, value: el.value });
  });
  return fields;
}
```

**SPPA-00 is 13 pages** — the editor needs scroll support and reasonable performance. Render pages lazily (only visible pages + 1 buffer page).

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `pages/pdf-editor.html` | Create | Standalone PDF.js viewer with form editing |
| `pages/admin.html` | Modify | Replace field editor with modal iframe opener |
| `server.js` | Modify (minimal) | Serve pdf-editor.html, ensure SPPA PDF endpoint works for both task types |

### What Already Exists

- `/api/admin/va/task/:id/sppa-pdf` — serves the current SPPA PDF as a binary response (GET)
- `/api/admin/va/task/:id/sppa-save-fields` — accepts `{ fields: [{name, value}] }` and amends the PDF via pdf-lib, uploads to Drive, delivers to MyDocuments
- `/api/admin/va/task/:id/sppa-form-fields` — extracts field names/values from the PDF (GET)
- `lib/sppa-pdf-fill.js` has `amendSppaFields(pdfBuffer, fieldUpdates)` for bulk field updates
- The SPPA-00 has 213 form fields (mix of text, checkbox, radio, signature)

### What to Remove

- The current "Edit SPPA-00 Fields" section in `renderOpsAhpraActionItem` that shows raw text inputs
- The `loadSppaFieldEditor()` and `saveSppaFieldsAndSend()` JS functions (replaced by the modal approach)

### Edge Cases

- The SPPA-00 PDF has some malformed fields (the high-level pdf-lib form API crashes on them) — that's why we use the low-level API. PDF.js should handle rendering fine since it's a viewer, not a form manipulator.
- Radio buttons (q6, q7, q8, q9, q14, q17, q19) need special handling — PDF.js renders them as radio inputs but the field names are hashes.
- Signature fields (Signature1-4) should be shown as read-only.
- The PDF is ~670KB — should load quickly.

### UI Design

- **Modal overlay**: full-screen dark overlay with the PDF editor taking ~90% of the viewport
- **Toolbar at top**: "Save & Close" button (green), "Cancel" button, zoom controls
- **PDF pages**: rendered with light gray background, centered, with form fields highlighted (light yellow background on editable fields)
- **Scroll**: vertical scroll through all 13 pages
- **Field highlighting**: when the RSO hovers over a field, show a tooltip with the field name

### Testing

1. Open an RSO amendment task → click "Edit SPPA-00"
2. PDF renders all 13 pages with form fields overlaid
3. Edit a text field (e.g., Q17 goals text) → field value changes visually
4. Click "Save & Close" → field changes sent to server → PDF updated → Drive updated → MyDocuments updated
5. Re-open the editor → confirm the changes persisted

## Priority

This is a UX enhancement — the current field editor works functionally. Build this when there's a dedicated session for it, not as a side task.
