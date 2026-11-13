import type { RateSheetMimeType } from '@marafiq/shared';

export interface ExtractionInput {
  file: Buffer;
  mimeType: RateSheetMimeType;
  fileName: string;
  /** Set on the single retry: what was wrong with the first answer. */
  previousError?: string;
}

/**
 * Reads a rate sheet and returns the parsed JSON the model produced. The
 * caller validates it with Zod; nothing returned here is trusted.
 */
export interface ExtractionAdapter {
  /** Model id, stored on the source document. */
  readonly model: string;
  extract(input: ExtractionInput): Promise<unknown>;
}

/** The model answered, but not with usable JSON. Worth one retry. */
export class ExtractionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionFormatError';
  }
}

/** docs/03 section 3, extended for files that hold several packs. */
export const EXTRACTION_SYSTEM_PROMPT = `You read Umrah supplier rate sheets (Pakistan travel agencies; Urdu and English) and return structured data. Return ONLY JSON matching the schema provided. Do not add commentary or code fences.

A file may contain several packs, usually one per page, each with its own name and night dates. Return one entry in "packs" for each.

Copy hotel names exactly as printed; put "OLD NAME" variants into aliasesPrinted. The sheet has a Makkah section and a Madina section: set city from the section the row is in. If one printed line names two different hotels side by side at one rate, return one row for each hotel with the same prices.

For each hotel row read the five numbers left to right as quint-sharing, quad, triple, double, room. Then choose pricingMode:
- "derived_per_person": a normal row of five numbers.
- "flat_per_room": the row is sold by the room. Either it shows an identical number such as "200-SR" under every column with the label ROOM BASIS, or its cells are labelled ROOM BASIS and the quint cell has no number. Put the ROOM column value in room, keep any other printed figures in perPerson, and explain in flatNote.
- "on_request": the row says "ON BOOKING". No prices.

Read the visa block in the header: the direct-flight rate, the indirect-flight rate for 1, 2, 3 and 4 pax, and the infant rate. Read dates from the header ("NIGHTS FROM ... > ...") and the effective and issue dates in the header and footer, as YYYY-MM-DD.

Ignore the terms and conditions paragraph. If any value is unclear, return null and lower that row's confidence; never invent or guess a value. The sheet may be a photo or scan; read carefully.`;

export const EXTRACTION_SCHEMA_TEXT = `Return this JSON shape. Amounts are whole SAR numbers as printed.

{
  "packs": [
    {
      "supplierName": "string|null",
      "packName": "string",
      "seasonLabel": "string|null",
      "nightFrom": "YYYY-MM-DD|null",
      "nightTo": "YYYY-MM-DD|null",
      "effectiveFrom": "YYYY-MM-DD|null",
      "issueDate": "YYYY-MM-DD|null",
      "currency": "SAR",
      "visa": {
        "directPerPerson": 0,
        "indirectByGroupSize": { "1": 0, "2": 0, "3": 0, "4": 0 },
        "infant": 0,
        "notes": "string|null"
      },
      "hotels": [
        {
          "city": "makkah|madinah",
          "name": "string (as printed)",
          "aliasesPrinted": ["string"],
          "distanceText": "string|null",
          "distanceMeters": "number|null",
          "transportText": "string|null",
          "pricingMode": "derived_per_person|flat_per_room|on_request",
          "room": "number|null",
          "perPerson": { "quint": "number|null", "quad": "number|null", "triple": "number|null", "double": "number|null" },
          "flatNote": "string|null",
          "page": 1,
          "row": 1,
          "confidence": 0.0
        }
      ],
      "warnings": ["string"]
    }
  ]
}`;

/** Models sometimes wrap JSON in a code fence or a sentence; take the object. */
export function parseModelJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new ExtractionFormatError('The answer contained no JSON object');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ExtractionFormatError('The answer was not valid JSON');
  }
}
