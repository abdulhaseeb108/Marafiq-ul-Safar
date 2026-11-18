import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOCUMENT_PARSER_LIMITS,
  DocumentResourceLimitError,
  MalformedDocumentError,
  parseSupplierDocument,
} from './document-parsers.js';

function onePagePdf(content: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${content}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf);
}

function png(width: number, height: number): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.write('IHDR', 12, 'ascii');
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

async function xlsxWithValues(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Supplier Rates');
  sheet.getCell('A1').value = 'Room Type';
  sheet.getCell('B1').value = 'SAR';
  sheet.getCell('A2').value = 'Double';
  sheet.getCell('B2').value = { formula: 'SUM(1, 2)', result: 3 };
  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data);
}

async function xlsxWithDistantCell(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Coordinates').getCell('AA20').value = 'value';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('supplier document parsers', () => {
  it('extracts PDF digital text with page provenance without claiming OCR', async () => {
    const parsed = await parseSupplierDocument(onePagePdf('Printed rates'), 'application/pdf');

    expect(parsed.status).toBe('processed');
    expect(parsed.evidence).toContainEqual(
      expect.objectContaining({
        kind: 'pdf_text',
        location: { page: 1, segment: 1 },
        metadata: expect.objectContaining({ ocrPerformed: false }),
      }),
    );
    expect(JSON.stringify(parsed.evidence)).toContain('Printed rates');
  });

  it('marks image-only PDF pages unmapped and explicitly notes that OCR was not performed', async () => {
    const parsed = await parseSupplierDocument(onePagePdf(''), 'application/pdf');

    expect(parsed.status).toBe('unmapped');
    expect(parsed.evidence[0]).toMatchObject({
      kind: 'image_reference',
      location: { page: 1 },
      content: { ocrPerformed: false },
    });
    expect(parsed.warnings.join(' ')).toMatch(/OCR was not performed/);
  });

  it('enforces PDF page limits', async () => {
    await expect(
      parseSupplierDocument(onePagePdf('one'), 'application/pdf', { maxPdfPages: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it('preserves image dimensions and never represents images as extracted text', async () => {
    const parsedPng = await parseSupplierDocument(png(120, 80), 'image/png');
    const parsedJpeg = await parseSupplierDocument(jpeg(640, 480), 'image/jpeg');

    expect(parsedPng.status).toBe('unmapped');
    expect(parsedPng.evidence[0]).toMatchObject({
      kind: 'image_reference',
      content: { width: 120, height: 80, ocrPerformed: false },
    });
    expect(parsedJpeg.evidence[0]).toMatchObject({
      kind: 'image_reference',
      content: { width: 640, height: 480 },
    });
  });

  it('rejects images exceeding side or pixel limits', async () => {
    await expect(parseSupplierDocument(png(11_000, 10), 'image/png')).rejects.toBeInstanceOf(
      DocumentResourceLimitError,
    );
    await expect(parseSupplierDocument(png(5_000, 5_000), 'image/png')).rejects.toBeInstanceOf(
      DocumentResourceLimitError,
    );
  });

  it('extracts XLSX values with sheet/cell provenance and preserves formulas without results', async () => {
    const parsed = await parseSupplierDocument(
      await xlsxWithValues(),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    expect(parsed.status).toBe('partial');
    expect(parsed.evidence).toContainEqual(
      expect.objectContaining({
        kind: 'spreadsheet_cell',
        location: expect.objectContaining({ sheet: 'Supplier Rates', row: 1 }),
      }),
    );
    const serialized = JSON.stringify(parsed.evidence);
    expect(serialized).toContain('Room Type');
    expect(serialized).toContain('SUM(1, 2)');
    expect(serialized).not.toContain('"result":3');
    expect(parsed.warnings.join(' ')).toMatch(/calculated results were not evaluated/);
  });

  it('enforces XLSX sheet and non-empty-cell limits', async () => {
    const data = await xlsxWithValues();
    await expect(
      parseSupplierDocument(
        data,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        {
          maxXlsxSheets: 1,
          maxXlsxCells: 1,
        },
      ),
    ).rejects.toBeInstanceOf(DocumentResourceLimitError);
  });

  it('records accurate XLSX row and column coordinates for multi-letter columns', async () => {
    const parsed = await parseSupplierDocument(
      await xlsxWithDistantCell(),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    expect(parsed.evidence[0]?.location).toMatchObject({
      sheet: 'Coordinates',
      row: 20,
      column: 27,
      cell: 'AA20:AA20',
    });
  });

  it('parses CSV with row and column provenance while preserving quoted text', async () => {
    const parsed = await parseSupplierDocument(
      Buffer.from('Room,Rate\r\n"Double, deluxe",125.50\r\n"Quad\nroom",300'),
      'text/csv',
    );

    expect(parsed.status).toBe('processed');
    expect(
      parsed.evidence.some((item) =>
        (item.content as { cells: { row: number; column: number }[] }).cells.some(
          (cell) => cell.row === 2 && cell.column === 1,
        ),
      ),
    ).toBe(true);
    const serialized = JSON.stringify(parsed.evidence);
    expect(serialized).toContain('Double, deluxe');
    expect(serialized).toContain('Quad\\nroom');
    expect(serialized).toContain('"header":"Rate"');
  });

  it('splits oversized CSV cells into bounded evidence without losing provenance', async () => {
    const value = 'rate,'.repeat(20_000);
    const parsed = await parseSupplierDocument(Buffer.from(`Rate\n"${value}"`), 'text/csv');

    expect(parsed.status).toBe('processed');
    expect(parsed.evidence.length).toBeGreaterThan(1);
    expect(
      parsed.evidence.every(
        (item) =>
          Buffer.byteLength(JSON.stringify(item.content)) <=
          DEFAULT_DOCUMENT_PARSER_LIMITS.evidenceChunkBytes,
      ),
    ).toBe(true);
    const segments = parsed.evidence.flatMap((item) =>
      (item.content as { cells: { row: number; value: string }[] }).cells
        .filter((cell) => cell.row === 2)
        .map((cell) => cell.value),
    );
    expect(segments.join('')).toBe(value);
    expect(
      parsed.evidence.some((item) =>
        (item.content as { cells: { row: number }[] }).cells.some((cell) => cell.row === 2),
      ),
    ).toBe(true);
  });

  it('rejects malformed CSV quoting and enforces row/column/cell limits', async () => {
    await expect(
      parseSupplierDocument(Buffer.from('"unterminated'), 'text/csv'),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
    await expect(
      parseSupplierDocument(Buffer.from('a,b,c'), 'text/csv', { maxCsvColumns: 2 }),
    ).rejects.toBeInstanceOf(DocumentResourceLimitError);
    await expect(
      parseSupplierDocument(Buffer.from('a\nb\nc'), 'text/csv', { maxCsvRecords: 2 }),
    ).rejects.toBeInstanceOf(DocumentResourceLimitError);
    await expect(
      parseSupplierDocument(Buffer.from('a,b'), 'text/csv', { maxCsvCells: 1 }),
    ).rejects.toBeInstanceOf(DocumentResourceLimitError);
  });

  it('keeps unknown formats unmapped and rejects malformed or oversized supported inputs', async () => {
    await expect(
      parseSupplierDocument(Buffer.from('bytes'), 'application/pdf'),
    ).rejects.toBeInstanceOf(MalformedDocumentError);
    const unknown = await parseSupplierDocument(Buffer.from('bytes'), 'application/octet-stream');
    expect(unknown).toMatchObject({
      status: 'unmapped',
      evidence: [],
    });
    expect(unknown.warnings.join(' ')).toMatch(/no parser is configured/i);
    await expect(
      parseSupplierDocument(Buffer.from('data'), 'text/csv', { maxFileBytes: 2 }),
    ).rejects.toBeInstanceOf(DocumentResourceLimitError);
    expect(DEFAULT_DOCUMENT_PARSER_LIMITS.maxFileBytes).toBe(20 * 1024 * 1024);
  });
});
