import Anthropic from '@anthropic-ai/sdk';
import {
  EXTRACTION_SCHEMA_TEXT,
  EXTRACTION_SYSTEM_PROMPT,
  ExtractionFormatError,
  parseModelJson,
  type ExtractionAdapter,
  type ExtractionInput,
} from './extraction.js';

/** Room for about 60 rows on each of several pages (docs/03 section 2). */
const MAX_TOKENS = 32_000;

/**
 * Sends the original file to the Anthropic API. A PDF goes as a document
 * block, which gives the model each page as both text and image; a photo goes
 * as an image block. One request per file.
 */
export class AnthropicExtraction implements ExtractionAdapter {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async extract(input: ExtractionInput): Promise<unknown> {
    const data = input.file.toString('base64');
    const fileBlock =
      input.mimeType === 'application/pdf'
        ? ({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data },
          } as const)
        : ({
            type: 'image',
            source: { type: 'base64', media_type: input.mimeType, data },
          } as const);

    const retryNote = input.previousError
      ? `\n\nYour previous answer was rejected: ${input.previousError}\nReturn the corrected JSON only.`
      : '';

    // Streamed so a long answer does not hit the non-streaming time limit.
    const message = await this.client.messages
      .stream({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [fileBlock, { type: 'text', text: EXTRACTION_SCHEMA_TEXT + retryNote }],
          },
        ],
      })
      .finalMessage();

    if (message.stop_reason === 'max_tokens') {
      throw new ExtractionFormatError('The answer was cut off before the JSON was complete');
    }
    const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    return parseModelJson(text);
  }
}
