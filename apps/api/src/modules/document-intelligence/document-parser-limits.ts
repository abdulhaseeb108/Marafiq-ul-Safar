export interface DocumentParserLimits {
  maxFileBytes: number;
  maxPdfPages: number;
  maxPdfPageTextBytes: number;
  maxImageSide: number;
  maxImagePixels: number;
  maxXlsxSheets: number;
  maxXlsxCells: number;
  maxXlsxZipEntries: number;
  maxXlsxUncompressedBytes: number;
  maxXlsxEntryBytes: number;
  maxXlsxCompressionRatio: number;
  maxCsvRecords: number;
  maxCsvColumns: number;
  maxCsvCells: number;
  maxEvidenceRecords: number;
  maxEvidenceBytes: number;
  evidenceChunkBytes: number;
}

export const DEFAULT_DOCUMENT_PARSER_LIMITS: Readonly<DocumentParserLimits> = {
  maxFileBytes: 20 * 1024 * 1024,
  maxPdfPages: 100,
  maxPdfPageTextBytes: 1024 * 1024,
  maxImageSide: 10_000,
  maxImagePixels: 20_000_000,
  maxXlsxSheets: 20,
  maxXlsxCells: 200_000,
  maxXlsxZipEntries: 1_000,
  maxXlsxUncompressedBytes: 64 * 1024 * 1024,
  maxXlsxEntryBytes: 16 * 1024 * 1024,
  maxXlsxCompressionRatio: 250,
  maxCsvRecords: 100_000,
  maxCsvColumns: 200,
  maxCsvCells: 1_000_000,
  maxEvidenceRecords: 10_000,
  maxEvidenceBytes: 32 * 1024 * 1024,
  evidenceChunkBytes: 48 * 1024,
};
