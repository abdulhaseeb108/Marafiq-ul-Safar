import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  MAX_EVIDENCE_CONTENT_BYTES,
  MAX_EVIDENCE_METADATA_BYTES,
} from './document-evidence.models.js';
import type { DocumentEvidenceInput } from './document-evidence.service.js';
import {
  DEFAULT_DOCUMENT_PARSER_LIMITS,
  type DocumentParserLimits,
} from './document-parser-limits.js';

export { DEFAULT_DOCUMENT_PARSER_LIMITS } from './document-parser-limits.js';
export type { DocumentParserLimits } from './document-parser-limits.js';

export type ParsedDocumentStatus = 'processed' | 'partial' | 'unmapped';

export interface ParsedDocument {
  status: ParsedDocumentStatus;
  evidence: DocumentEvidenceInput[];
  warnings: string[];
}

export class DocumentResourceLimitError extends Error {
  constructor(limit: string) {
    super(`Document exceeded processing resource limit: ${limit}.`);
    this.name = 'DocumentResourceLimitError';
  }
}

export class UnsafeDocumentContentError extends Error {
  constructor(reason: string) {
    super(`The XLSX contains unsupported active or external content: ${reason}.`);
    this.name = 'UnsafeDocumentContentError';
  }
}

export class MalformedDocumentError extends Error {
  constructor(format: string) {
    super(`The ${format} document is malformed or incomplete.`);
    this.name = 'MalformedDocumentError';
  }
}

function assertLimits(limits: DocumentParserLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  }
  if (limits.evidenceChunkBytes > MAX_EVIDENCE_CONTENT_BYTES)
    throw new RangeError('evidenceChunkBytes exceeds the model content limit.');
}

function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') throw new MalformedDocumentError('extracted evidence');
  return Buffer.byteLength(json, 'utf8');
}

function newCollector(limits: DocumentParserLimits) {
  const evidence: DocumentEvidenceInput[] = [];
  let totalBytes = 0;
  return {
    evidence,
    add(item: DocumentEvidenceInput) {
      const contentBytes = jsonBytes(item.content);
      const metadataBytes = item.metadata === undefined ? 0 : jsonBytes(item.metadata);
      if (contentBytes > limits.evidenceChunkBytes || contentBytes > MAX_EVIDENCE_CONTENT_BYTES) {
        throw new DocumentResourceLimitError('evidence chunk bytes');
      }
      if (metadataBytes > MAX_EVIDENCE_METADATA_BYTES) {
        throw new DocumentResourceLimitError('evidence metadata bytes');
      }
      totalBytes += contentBytes + metadataBytes;
      if (totalBytes > limits.maxEvidenceBytes)
        throw new DocumentResourceLimitError('evidence bytes');
      evidence.push(item);
      if (evidence.length > limits.maxEvidenceRecords) {
        throw new DocumentResourceLimitError('evidence record count');
      }
    },
  };
}

function checkInput(data: Buffer, limits: DocumentParserLimits): void {
  if (data.length === 0) throw new MalformedDocumentError('empty');
  if (data.length > limits.maxFileBytes) throw new DocumentResourceLimitError('file size');
}

function hasPrefix(data: Buffer, signature: number[]): boolean {
  return signature.every((byte, index) => data[index] === byte);
}

function splitText(value: string, maximumBytes: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (currentBytes + bytes > maximumBytes && current) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

async function parsePdf(data: Buffer, limits: DocumentParserLimits): Promise<ParsedDocument> {
  if (!hasPrefix(data, [0x25, 0x50, 0x44, 0x46])) throw new MalformedDocumentError('PDF');
  const collector = newCollector(limits);
  const loadingTask = getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
    stopAtErrors: true,
  });
  let textPages = 0;
  let emptyPages = 0;
  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1) throw new MalformedDocumentError('PDF');
    if (document.numPages > limits.maxPdfPages) throw new DocumentResourceLimitError('PDF pages');

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      const items = text.items.flatMap((item) =>
        'str' in item && item.str.trim() ? [{ text: item.str, hasEOL: item.hasEOL }] : [],
      );
      const pageTextBytes = items.reduce(
        (sum, item) => sum + Buffer.byteLength(item.text, 'utf8'),
        0,
      );
      if (pageTextBytes > limits.maxPdfPageTextBytes)
        throw new DocumentResourceLimitError('PDF page text bytes');

      if (items.length === 0) {
        emptyPages += 1;
        collector.add({
          kind: 'image_reference',
          location: { page: pageNumber },
          content: { type: 'page_without_digital_text', ocrPerformed: false },
          metadata: { parser: 'pdfjs-dist', ocrPerformed: false },
        });
        continue;
      }

      textPages += 1;
      let segment = 0;
      let chunk: { text: string; hasEOL: boolean }[] = [];
      const flush = () => {
        if (chunk.length === 0) return;
        segment += 1;
        collector.add({
          kind: 'pdf_text',
          location: { page: pageNumber, segment },
          content: { items: chunk },
          metadata: { parser: 'pdfjs-dist', ocrPerformed: false },
        });
        chunk = [];
      };
      for (const item of items) {
        const parts = splitText(item.text, Math.max(1, Math.floor(limits.evidenceChunkBytes / 8)));
        for (let part = 0; part < parts.length; part += 1) {
          const partText = parts[part];
          if (partText === undefined) throw new MalformedDocumentError('PDF text');
          const itemPart = {
            text: partText,
            hasEOL: part === parts.length - 1 ? item.hasEOL : false,
          };
          if (
            chunk.length > 0 &&
            jsonBytes({ items: [...chunk, itemPart] }) > limits.evidenceChunkBytes
          ) {
            flush();
          }
          chunk.push(itemPart);
        }
      }
      flush();
      page.cleanup();
    }
  } catch (error) {
    if (error instanceof DocumentResourceLimitError || error instanceof MalformedDocumentError)
      throw error;
    throw new MalformedDocumentError('PDF');
  } finally {
    await loadingTask.destroy();
  }

  const status = textPages === 0 ? 'unmapped' : emptyPages > 0 ? 'partial' : 'processed';
  return {
    status,
    evidence: collector.evidence,
    warnings:
      emptyPages > 0
        ? [`${emptyPages} page(s) have no extractable digital text; OCR was not performed.`]
        : [],
  };
}

function imageDimensions(data: Buffer, mimeType: string): { width: number; height: number } {
  if (mimeType === 'image/png') {
    if (
      !hasPrefix(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
      data.length < 24 ||
      data.toString('ascii', 12, 16) !== 'IHDR'
    ) {
      throw new MalformedDocumentError('PNG');
    }
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (!hasPrefix(data, [0xff, 0xd8, 0xff])) throw new MalformedDocumentError('JPEG');
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) throw new MalformedDocumentError('JPEG');
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    offset += 1;
    if (marker === undefined) break;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) break;
    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > data.length)
      throw new MalformedDocumentError('JPEG');
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (segmentLength < 7) throw new MalformedDocumentError('JPEG');
      return {
        height: data.readUInt16BE(offset + 3),
        width: data.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  throw new MalformedDocumentError('JPEG');
}

function parseImage(
  data: Buffer,
  mimeType: 'image/png' | 'image/jpeg',
  limits: DocumentParserLimits,
): ParsedDocument {
  const { width, height } = imageDimensions(data, mimeType);
  if (width < 1 || height < 1 || width > limits.maxImageSide || height > limits.maxImageSide) {
    throw new DocumentResourceLimitError('image dimensions');
  }
  if (width * height > limits.maxImagePixels) throw new DocumentResourceLimitError('image pixels');
  const collector = newCollector(limits);
  collector.add({
    kind: 'image_reference',
    location: { page: 1 },
    content: { width, height, mimeType, ocrPerformed: false },
    metadata: { parser: 'image-reference', ocrPerformed: false },
  });
  return {
    status: 'unmapped',
    evidence: collector.evidence,
    warnings: ['Image was retained as a reference; OCR was not performed.'],
  };
}

interface ZipEntrySummary {
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
}

function inspectXlsxZip(data: Buffer, limits: DocumentParserLimits): ZipEntrySummary[] {
  const minimum = Math.max(0, data.length - 65_557);
  let eocd = -1;
  for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || data.length < 22) throw new MalformedDocumentError('XLSX ZIP container');

  const diskNumber = data.readUInt16LE(eocd + 4);
  const centralDisk = data.readUInt16LE(eocd + 6);
  const entries = data.readUInt16LE(eocd + 10);
  const centralBytes = data.readUInt32LE(eocd + 12);
  const centralOffset = data.readUInt32LE(eocd + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entries === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff ||
    entries > limits.maxXlsxZipEntries ||
    centralOffset + centralBytes > eocd
  ) {
    throw new DocumentResourceLimitError('XLSX ZIP directory');
  }

  let offset = centralOffset;
  let totalBytes = 0;
  const summaries: ZipEntrySummary[] = [];
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50)
      throw new MalformedDocumentError('XLSX ZIP directory');
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const compressedBytes = data.readUInt32LE(offset + 20);
    const uncompressedBytes = data.readUInt32LE(offset + 24);
    const nameBytes = data.readUInt16LE(offset + 28);
    const extraBytes = data.readUInt16LE(offset + 30);
    const commentBytes = data.readUInt16LE(offset + 32);
    const entryEnd = offset + 46 + nameBytes + extraBytes + commentBytes;
    if (
      entryEnd > data.length ||
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff ||
      (flags & 1) !== 0 ||
      ![0, 8].includes(method)
    ) {
      throw new MalformedDocumentError('XLSX ZIP entry');
    }
    const name = data.toString('utf8', offset + 46, offset + 46 + nameBytes);
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').includes('..') ||
      /(^|\/)(vbaProject\.bin|embeddings\/|externalLinks\/)/i.test(name)
    ) {
      throw new UnsafeDocumentContentError('macros, embeddings, or external links');
    }
    if (
      uncompressedBytes > limits.maxXlsxEntryBytes ||
      (uncompressedBytes > 0 &&
        (compressedBytes === 0 ||
          uncompressedBytes / compressedBytes > limits.maxXlsxCompressionRatio))
    ) {
      throw new DocumentResourceLimitError('XLSX ZIP expansion');
    }
    totalBytes += uncompressedBytes;
    if (totalBytes > limits.maxXlsxUncompressedBytes)
      throw new DocumentResourceLimitError('XLSX expanded bytes');
    summaries.push({ name, compressedBytes, uncompressedBytes });
    offset = entryEnd;
  }

  const names = new Set(summaries.map((entry) => entry.name));
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) {
    throw new MalformedDocumentError('XLSX workbook structure');
  }
  return summaries;
}

function serializedCellValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MalformedDocumentError('XLSX cell');
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializedCellValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.formula === 'string') return { formula: record.formula };
    if (typeof record.sharedFormula === 'string') return { sharedFormula: record.sharedFormula };
    if (Array.isArray(record.richText)) {
      return {
        richText: record.richText.map((fragment) =>
          fragment && typeof fragment === 'object' && 'text' in fragment
            ? String((fragment as { text: unknown }).text)
            : '',
        ),
      };
    }
    if (typeof record.text === 'string') {
      return {
        text: record.text,
        ...(typeof record.hyperlink === 'string' ? { hyperlink: record.hyperlink } : {}),
      };
    }
    if (typeof record.error === 'string') return { error: record.error };
  }
  throw new MalformedDocumentError('XLSX cell value');
}

function splitCellValue(value: unknown, maximumBytes: number): unknown[] {
  if (typeof value !== 'string' || jsonBytes(value) <= maximumBytes) return [value];
  return splitText(value, Math.max(1, Math.floor(maximumBytes / 4)));
}

function excelCellCoordinates(reference: string): { row: number; column: number } {
  const match = /^([A-Z]+)([1-9]\d*)$/i.exec(reference);
  if (!match) throw new MalformedDocumentError('XLSX cell reference');
  const columnLetters = match[1];
  const rowText = match[2];
  if (columnLetters === undefined || rowText === undefined)
    throw new MalformedDocumentError('XLSX cell reference');
  let column = 0;
  for (const character of columnLetters.toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return { row: Number(rowText), column };
}

async function parseXlsx(data: Buffer, limits: DocumentParserLimits): Promise<ParsedDocument> {
  if (!hasPrefix(data, [0x50, 0x4b, 0x03, 0x04])) throw new MalformedDocumentError('XLSX');
  inspectXlsxZip(data, limits);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.read(Readable.from([data]));
  if (workbook.worksheets.length === 0) throw new MalformedDocumentError('XLSX workbook');
  if (workbook.worksheets.length > limits.maxXlsxSheets)
    throw new DocumentResourceLimitError('XLSX sheets');

  const collector = newCollector(limits);
  let cellCount = 0;
  let formulaCount = 0;
  for (const worksheet of workbook.worksheets) {
    let chunk: { ref: string; value: unknown; segment?: number }[] = [];
    let chunkBytes = 0;
    let chunkNumber = 0;
    const flush = () => {
      if (chunk.length === 0) return;
      chunkNumber += 1;
      const first = chunk[0];
      const last = chunk.at(-1);
      if (!first || !last) throw new MalformedDocumentError('XLSX evidence');
      const { row, column } = excelCellCoordinates(first.ref);
      const evidence = {
        kind: 'spreadsheet_cell' as const,
        location: {
          sheet: worksheet.name,
          row: row ?? 1,
          column: column ?? 1,
          cell: `${first.ref}:${last.ref}`.slice(0, 32),
          segment: chunkNumber,
        },
        content: { cells: chunk },
        metadata: { parser: 'exceljs', sheetId: worksheet.id, formulasAreTextOnly: true },
      };
      collector.add(evidence);
      chunk = [];
      chunkBytes = 0;
    };

    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.value === null || cell.value === undefined || cell.value === '') return;
        cellCount += 1;
        if (cellCount > limits.maxXlsxCells)
          throw new DocumentResourceLimitError('XLSX non-empty cells');
        const value = serializedCellValue(cell.value);
        if (
          value !== null &&
          typeof value === 'object' &&
          ('formula' in value || 'sharedFormula' in value)
        ) {
          formulaCount += 1;
        }
        const pieces = splitCellValue(value, limits.evidenceChunkBytes - 512);
        for (let part = 0; part < pieces.length; part += 1) {
          const entry = {
            ref: cell.address,
            value: pieces[part],
            ...(pieces.length > 1 ? { segment: part + 1 } : {}),
          };
          const entryBytes = jsonBytes(entry);
          if (chunk.length > 0 && chunkBytes + entryBytes > limits.evidenceChunkBytes - 1024) {
            flush();
          }
          chunk.push(entry);
          chunkBytes += entryBytes;
        }
      });
    });
    flush();
  }

  return {
    status: cellCount === 0 ? 'unmapped' : formulaCount > 0 ? 'partial' : 'processed',
    evidence: collector.evidence,
    warnings:
      formulaCount > 0
        ? [
            `${formulaCount} formula cell(s) were preserved as formulas; calculated results were not evaluated.`,
          ]
        : [],
  };
}

interface CsvRecord {
  row: number;
  values: string[];
}

function* csvRecords(text: string, limits: DocumentParserLimits): Generator<CsvRecord> {
  let record: string[] = [];
  let field = '';
  let row = 1;
  let inQuotes = false;
  let afterQuote = false;
  let cells = 0;

  const pushField = () => {
    record.push(field);
    field = '';
    afterQuote = false;
    if (record.length > limits.maxCsvColumns) throw new DocumentResourceLimitError('CSV columns');
    cells += 1;
    if (cells > limits.maxCsvCells) throw new DocumentResourceLimitError('CSV cells');
  };

  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) throw new MalformedDocumentError('CSV');
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (afterQuote && character !== ',' && character !== '\r' && character !== '\n') {
      throw new MalformedDocumentError('CSV');
    }
    if (character === '"') {
      if (field.length !== 0 || afterQuote) throw new MalformedDocumentError('CSV');
      inQuotes = true;
      continue;
    }
    if (character === ',') {
      pushField();
      continue;
    }
    if (character === '\r' || character === '\n') {
      pushField();
      if (row > limits.maxCsvRecords) throw new DocumentResourceLimitError('CSV records');
      yield { row, values: record };
      row += 1;
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      record = [];
      continue;
    }
    field += character;
  }
  if (inQuotes) throw new MalformedDocumentError('CSV');
  if (field.length > 0 || record.length > 0 || afterQuote) {
    pushField();
    if (row > limits.maxCsvRecords) throw new DocumentResourceLimitError('CSV records');
    yield { row, values: record };
  }
}

function parseCsv(data: Buffer, limits: DocumentParserLimits): ParsedDocument {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new MalformedDocumentError('CSV');
  }
  if (text.includes('\0')) throw new MalformedDocumentError('CSV');
  const collector = newCollector(limits);
  let entries: { row: number; column: number; value: string; header?: string }[] = [];
  let chunkBytes = 0;
  let chunkNumber = 0;
  let header: string[] | undefined;
  let records = 0;
  let cells = 0;
  const flush = () => {
    if (entries.length === 0) return;
    chunkNumber += 1;
    const first = entries[0];
    const last = entries.at(-1);
    if (!first || !last) throw new MalformedDocumentError('CSV evidence');
    collector.add({
      kind: 'csv_record',
      location: {
        row: first.row,
        column: first.column,
        cell: `R${first.row}C${first.column}:R${last.row}C${last.column}`.slice(0, 32),
        segment: chunkNumber,
      },
      content: { cells: entries },
      metadata: { parser: 'csv', headersPreservedAsPrinted: true },
    });
    entries = [];
    chunkBytes = 0;
  };

  try {
    for (const record of csvRecords(text, limits)) {
      records += 1;
      if (records === 1) header = record.values;
      for (const [index, value] of record.values.entries()) {
        cells += 1;
        const baseEntry = {
          row: record.row,
          column: index + 1,
        };
        const headerValue =
          records > 1 && header?.[index] !== undefined ? header[index] : undefined;
        const partLimit = Math.max(1, Math.floor(limits.evidenceChunkBytes / 16));
        const valueParts = splitText(value, partLimit);
        const headerParts =
          headerValue === undefined ? [undefined] : splitText(headerValue, partLimit);
        const partCount = Math.max(valueParts.length, headerParts.length);
        for (let part = 0; part < partCount; part += 1) {
          const entry = {
            ...baseEntry,
            value: valueParts[part] ?? '',
            ...(headerParts[part] !== undefined ? { header: headerParts[part] } : {}),
            ...(partCount > 1 ? { valueSegment: part + 1, valueSegments: partCount } : {}),
          };
          const entryBytes = jsonBytes(entry);
          if (entries.length > 0 && chunkBytes + entryBytes > limits.evidenceChunkBytes - 1024) {
            flush();
          }
          entries.push(entry);
          chunkBytes += entryBytes;
        }
      }
    }
  } catch (error) {
    if (error instanceof DocumentResourceLimitError || error instanceof MalformedDocumentError)
      throw error;
    throw new MalformedDocumentError('CSV');
  }
  flush();
  return {
    status: cells === 0 ? 'unmapped' : 'processed',
    evidence: collector.evidence,
    warnings: [],
  };
}

export async function parseSupplierDocument(
  data: Buffer,
  mimeType: string,
  configuredLimits: Partial<DocumentParserLimits> = {},
): Promise<ParsedDocument> {
  const limits = { ...DEFAULT_DOCUMENT_PARSER_LIMITS, ...configuredLimits };
  assertLimits(limits);
  checkInput(data, limits);

  switch (mimeType) {
    case 'application/pdf':
      return parsePdf(data, limits);
    case 'image/png':
    case 'image/jpeg':
      return parseImage(data, mimeType, limits);
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return parseXlsx(data, limits);
    case 'text/csv':
      return parseCsv(data, limits);
    default:
      return {
        status: 'unmapped',
        evidence: [],
        warnings: [
          `No parser is configured for ${mimeType}; the original document was retained without extraction.`,
        ],
      };
  }
}
