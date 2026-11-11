# Marafiq us Safar — Build Pack

Give this folder to an AI coding agent (Claude Code with Claude Fable 5.2) and it can build the MVP in phases.

## What is inside
| File | Purpose |
|---|---|
| `CLAUDE.md` | Rules the AI reads every session (stack, money rules, status words, never-do list) |
| `docs/01-PRODUCT-SPEC.md` | What the site and admin portal do, calculator inputs and outputs, acceptance |
| `docs/02-DATA-MODEL-AND-API.md` | Collections, statuses, permissions, API routes, env variables |
| `docs/03-RATE-SHEET-INGESTION-AND-PRICING.md` | How WhatsApp PDFs become published rates; extraction schema and prompt; pricing algorithm; test cases with exact numbers |
| `docs/04-BUILD-PHASES.md` | Eight copy-paste prompts, Phase 0 to 7, each with acceptance checks |
| `docs/05-OPEN-DECISIONS.md` | Questions still open and the safe default the AI will use |
| `docs/seed/` | Sample rate sheet PDFs and a JSON fixture for tests |

## How to use it (step by step)
1. Install Node 20, Git and Claude Code. Create a new empty Git repo and copy this whole folder into it.
2. Create free accounts: MongoDB Atlas, Cloudflare (R2 and Pages), Resend, Sentry, and the Anthropic API (set a monthly spending cap).
3. Copy `.env.example` (created in Phase 0) to `.env` and fill it in. Never commit `.env`.
4. Open the repo in Claude Code, choose Claude Fable 5.2, and paste the **Phase 0** prompt from `docs/04-BUILD-PHASES.md`.
5. When the AI reports done, run `npm test` and `npm run dev`, check the acceptance list, commit, then start a new session for the next phase.
6. Do not skip phases. Phases 3 and 4 (rate sheets and pricing) are the most important; read the test numbers yourself.
7. Edit `docs/05-OPEN-DECISIONS.md` as you learn answers; the AI reads it.

## What you must provide or decide (the AI cannot)
- Company name, address, contact numbers, logo and brand colors.
- Current SAR→PKR rate and your markup (default 0%).
- Flight estimate figures from your partner agency.
- Legal text (privacy, terms, quote terms) reviewed by a lawyer, and Urdu copy reviewed by a native speaker.
- Confirmation of your travel/Umrah permissions before launch, and answers to the visa and flat-room questions in doc 05.

## Not in this version
Online payments, customer accounts, live hotel/flight search, ticket issuing, supplier portal, automated WhatsApp intake. These come later, after the pilot.
