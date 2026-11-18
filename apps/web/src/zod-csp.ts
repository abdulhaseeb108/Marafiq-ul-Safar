/**
 * Imported first in main.tsx, before anything that builds a schema.
 *
 * The site's content security policy has no 'unsafe-eval'
 * (public/_headers). Zod 4 normally compiles object validators with
 * `new Function`, after a probe that the browser reports as a CSP violation
 * even though Zod catches it. Jitless mode validates the same way without
 * generated code. Zod reads the setting when each schema is created, and the
 * shared schemas are created when @marafiq/shared loads, so this module must
 * run before that import: keep it the first import in main.tsx.
 */
import { config } from 'zod';

config({ jitless: true });
