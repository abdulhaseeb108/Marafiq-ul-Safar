# Phase 4A — Supplier document intake and evidence processing

Phase 4A adds an isolated document-intelligence intake path. It does not replace
the Phase 3 rate-sheet upload/extraction/review/publish workflow and does not
create canonical pricing records.

## Intake and processing

- Staff upload PDF, PNG, JPEG, XLSX, or UTF-8 CSV files through
  `POST /api/v1/admin/document-intelligence/source-documents`.
- Unknown formats are retained as `application/octet-stream` and, after a clean
  scan, finish unmapped without a parser or fabricated evidence.
- Original files use the existing private storage adapter and source-document
  key namespace. SHA-256 duplicate detection is scoped to the supplier.
- A MongoDB job is created with an idempotency key derived from the source
  document, content hash, and `p4a-v1` pipeline version.
- A single worker claims jobs atomically, scans before parsing, renews its lease,
  recovers expired leases, and retries within the job's bounded attempt budget.
- Evidence is immutable, bounded, and linked to its source document and job.
  PDF pages, spreadsheet sheets/cells, and CSV rows/columns are recorded only
  when the parser can establish them.
- Processing is at-least-once. Evidence writes use stable identity keys and
  MongoDB transactions; any future external side effect must also be idempotent.

## Malware and extraction policy

The scanner adapter is provider-independent, but no scanner provider is
configured in this phase. The server uses an explicit unavailable scanner and
logs that limitation at startup. Such jobs fail closed and end in the visible
`scan_unavailable` state after bounded retries. No parser is called unless a
scanner returns a valid `clean` verdict. An infected verdict is terminal, never reaches parsing, and is access-quarantined:
the staff download endpoint refuses the file while its original remains in
private storage.

There is no OCR or AI extraction. Digital PDF text, spreadsheet cells, and CSV
values are preserved as unreviewed evidence. Images and PDF pages without
digital text are marked unmapped with an explicit OCR-not-performed note.
Unsupported or malformed inputs fail visibly. Nothing is converted into rates
or published automatically.

## Staff endpoints

- `GET /api/v1/admin/document-intelligence/source-documents/:id/processing`
- `GET /api/v1/admin/document-intelligence/source-documents/:id/file`
- `GET /api/v1/admin/document-intelligence/source-documents/:id/evidence?page=1&limit=50`
- `POST /api/v1/admin/document-intelligence/source-documents/:id/retry`

Manual retry is available for failed and scanner-unavailable jobs. Infected and
successfully processed jobs cannot be retried through this endpoint.

## Initial resource limits

All limits are configurable through `DOCUMENT_*` environment variables and
validated at startup. Defaults include:

| Resource | Default |
|---|---:|
| Upload bytes | 20 MiB |
| Concurrent in-memory uploads | 2 |
| Worker processing concurrency | 1 |
| PDF pages / page text | 100 / 1 MiB |
| Image side / pixels | 10,000 / 20 million |
| XLSX sheets / non-empty cells | 20 / 200,000 |
| XLSX expanded bytes / entry bytes | 64 MiB / 16 MiB |
| CSV records / columns / cells | 100,000 / 200 / 1,000,000 |
| Evidence records / total bytes / chunk bytes | 10,000 / 32 MiB / 48 KiB |

These are initial safeguards, not validated production sizing. Tune them only
after testing representative supplier documents and observing memory/runtime.
The upload path buffers at most the configured number of files concurrently;
the durable processing queue itself is MongoDB-backed, not in-memory.

## Deliberate Phase 4A exclusions

No supplier terminology mapping, confidence scoring, canonical pricing
conversion, human evidence review UI, OCR provider, AI provider, rate creation,
or publication is included. Those capabilities require later phases and must
continue to leave the existing pricing engine and WMT records unchanged.
