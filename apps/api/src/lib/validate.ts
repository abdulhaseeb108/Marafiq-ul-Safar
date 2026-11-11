import type { z } from 'zod';
import { HttpError } from './http-error.js';

/** Parse with Zod or throw a 400 with one message per field. */
export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  throw new HttpError(400, 'validation_error', 'Please check the highlighted fields', fields);
}
