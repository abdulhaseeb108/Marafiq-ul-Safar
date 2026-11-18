/**
 * Staff routes for leads and quotes (docs/02 sections 3-4).
 * Leads: admin and sales manage; ops and finance read.
 * Quotes: admin and sales build and send; finance reads; ops has no access.
 */
import {
  LeadListQuerySchema,
  LeadMessageBodySchema,
  LeadNoteBodySchema,
  UpdateLeadBodySchema,
  UpdateQuoteBodySchema,
} from '@marafiq/shared';
import type { Request, Response } from 'express';
import { actorOf } from '../../lib/actor.js';
import type { AdminRoute } from '../../lib/admin-route.js';
import { unauthenticated } from '../../lib/http-error.js';
import { parseOrThrow } from '../../lib/validate.js';
import {
  LEAD_MANAGERS,
  LEAD_READERS,
  addLeadMessage,
  addLeadNote,
  getLeadDetail,
  listAssignees,
  listLeads,
  updateLead,
  type LeadsDeps,
} from './leads.service.js';
import {
  createQuote,
  getQuoteDetail,
  newQuoteVersion,
  rotateQuoteLink,
  sendQuote,
  updateQuote,
} from './quotes.service.js';

const param = (req: Request) => String(req.params.id);

function auth(req: Request) {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}

export function leadsAdminRoutes(deps: LeadsDeps): AdminRoute[] {
  return [
    {
      method: 'get',
      path: '/leads',
      roles: LEAD_READERS,
      handler: async (req: Request, res: Response) => {
        const { userId, role } = auth(req);
        res.json(await listLeads(parseOrThrow(LeadListQuerySchema, req.query), userId, role));
      },
    },
    {
      method: 'get',
      path: '/leads/assignees',
      roles: LEAD_MANAGERS,
      handler: async (_req: Request, res: Response) => {
        res.json({ items: await listAssignees() });
      },
    },
    {
      method: 'get',
      path: '/leads/:id',
      roles: LEAD_READERS,
      handler: async (req: Request, res: Response) => {
        res.json(await getLeadDetail(param(req), auth(req).role));
      },
    },
    {
      method: 'patch',
      path: '/leads/:id',
      roles: LEAD_MANAGERS,
      handler: async (req: Request, res: Response) => {
        await updateLead(param(req), parseOrThrow(UpdateLeadBodySchema, req.body), actorOf(req));
        res.json(await getLeadDetail(param(req), auth(req).role));
      },
    },
    {
      method: 'post',
      path: '/leads/:id/notes',
      roles: LEAD_MANAGERS,
      handler: async (req: Request, res: Response) => {
        await addLeadNote(
          param(req),
          parseOrThrow(LeadNoteBodySchema, req.body).body,
          actorOf(req),
        );
        res.status(201).json(await getLeadDetail(param(req), auth(req).role));
      },
    },
    {
      method: 'post',
      path: '/leads/:id/messages',
      roles: LEAD_MANAGERS,
      handler: async (req: Request, res: Response) => {
        await addLeadMessage(
          param(req),
          parseOrThrow(LeadMessageBodySchema, req.body),
          actorOf(req),
        );
        res.status(201).json(await getLeadDetail(param(req), auth(req).role));
      },
    },
    {
      method: 'post',
      path: '/leads/:id/quotes',
      roles: LEAD_MANAGERS,
      handler: async (req: Request, res: Response) => {
        res.status(201).json(await createQuote(param(req), actorOf(req)));
      },
    },
    {
      method: 'get',
      path: '/quotes/:id',
      roles: ['admin', 'sales', 'finance'],
      handler: async (req: Request, res: Response) => {
        res.json(await getQuoteDetail(param(req)));
      },
    },
    {
      method: 'put',
      path: '/quotes/:id',
      roles: LEAD_MANAGERS,
      handler: async (req: Request, res: Response) => {
        res.json(
          await updateQuote(
            param(req),
            parseOrThrow(UpdateQuoteBodySchema, req.body),
            actorOf(req),
          ),
        );
      },
    },
    {
      method: 'post',
      path: '/quotes/:id/send',
      roles: LEAD_MANAGERS,
      handler: async (req: Request, res: Response) => {
        res.json(await sendQuote(param(req), actorOf(req), deps));
      },
    },
    {
      method: 'post',
      path: '/quotes/:id/new-version',
      roles: LEAD_MANAGERS,
      handler: async (req: Request, res: Response) => {
        res.status(201).json(await newQuoteVersion(param(req), actorOf(req)));
      },
    },
    {
      method: 'post',
      path: '/quotes/:id/link',
      roles: LEAD_MANAGERS,
      handler: async (req: Request, res: Response) => {
        res.json(await rotateQuoteLink(param(req), actorOf(req), deps));
      },
    },
  ];
}
