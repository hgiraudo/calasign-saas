# Fields and anchor text

`PUT /v1/envelopes/{id}/fields` **replaces** all fields of a draft. Each field belongs to one recipient
(`recipientId`, which must be a `signer` of the envelope).

Types: `signature`, `initials`, `date_signed`, `name`, `email`, `text`, `number`, `checkbox`, `dropdown`
(needs `options`), `company`, `title`, `attachment`. Common props: `required` (default true), `label`,
`value` (prefill), `readOnly`, `min`/`max` (number), `conditions`, `formula` (calculated numbers).

## Option A — anchor text (recommended)

Put a marker in the document (e.g. `[[firma]]`, `[[firma_2]]`, `[[fecha]]`, `\s1\`) and reference it:

```json
{
  "recipientId": "<signer uuid>",
  "type": "signature",
  "anchor": {
    "text": "[[firma]]",       // 1–100 chars, searched in the PDF text layer
    "width": 150, "height": 40, // size in PDF points (1 pt = 1/72 in)
    "offsetX": 0, "offsetY": -30,  // shift in points from the top-left of the found text (+y = down)
    "caseSensitive": true,
    "ignoreIfNotPresent": false     // true: skip silently instead of failing with anchor_not_found
  }
}
```

- Every occurrence of the text creates one field (in all documents, or only `documentId` if given).
- The box starts at the top-left corner of the marker text, so `offsetY: -30` puts a 40 pt-high signature
  slightly above the marker line. To cover the marker exactly, use offsets 0.
- Tip: make markers white or tiny in the source document so they don't show in the final PDF; they must still
  be real text (not an image; scanned PDFs have no text layer).
- One marker per signer (`[[firma_1]]`, `[[firma_2]]`…) is the clearest way to handle several signers.
- A missing marker fails with HTTP 400 `anchor_not_found` (`details.anchor`).

## Option B — coordinates

```json
{ "documentId": "<doc uuid>", "recipientId": "<signer uuid>", "type": "signature",
  "page": 0, "x": 0.55, "y": 0.82, "width": 0.3, "height": 0.06 }
```

- `page` is 0-based. `x, y, width, height` are fractions (0–1) of the visible page, origin top-left.
- Page sizes come back in the upload response (`pages[i].width/height`, points) if you need to convert.
- Typical spots: bottom-right of last page `x 0.55, y 0.82, w 0.3, h 0.06`; bottom-left `x 0.08`.

## Several signers side by side (coordinates)

Signer 1 `x 0.08`, signer 2 `x 0.55`, same `y`; add a `date_signed` (`h 0.025`) under each signature.

## In MCP

When using `create_envelope` (if available), pass the same field objects (anchor or coordinates) or the
anchor text the tool accepts — read the tool's input schema. Templates already contain their fields.
