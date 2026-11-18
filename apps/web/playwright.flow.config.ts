/**
 * npm run e2e:flow: the whole quote flow against a real API and a wiped
 * end-to-end database (see playwright.config.ts). A separate config file
 * instead of an E2E_FLOW=1 prefix, which Windows shells do not understand.
 */
import { playwrightConfig } from './playwright.config';

export default playwrightConfig(true);
