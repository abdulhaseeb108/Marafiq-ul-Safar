import { RATE_SHEET_MIME_TYPES } from '@marafiq/shared';

export const DOCUMENT_INTELLIGENCE_MIME_TYPES = [
  ...RATE_SHEET_MIME_TYPES,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/octet-stream',
] as const;

export type DocumentIntelligenceMimeType = (typeof DOCUMENT_INTELLIGENCE_MIME_TYPES)[number];
