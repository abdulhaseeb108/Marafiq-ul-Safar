import {
  AddHotelRateBodySchema,
  ConfirmHotelBodySchema,
  ListQuerySchema,
  PublishBodySchema,
  RatePackageListQuerySchema,
  RejectBodySchema,
  UpdateHotelRateBodySchema,
  UpdateRatePackageBodySchema,
} from '@marafiq/shared';
import type { Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { ExtractionAdapter } from '../../adapters/extraction/extraction.js';
import type { StorageAdapter } from '../../adapters/storage/storage.js';
import { actorOf } from '../../lib/actor.js';
import type { AdminRoute } from '../../lib/admin-route.js';
import { HttpError } from '../../lib/http-error.js';
import { parseOrThrow } from '../../lib/validate.js';
import {
  beginExtraction,
  completeExtraction,
  createBlankPackage,
  getDocument,
  getDocumentFile,
  listDocuments,
  uploadDocument,
} from './documents.service.js';
import {
  addHotelRate,
  confirmHotel,
  deleteHotelRate,
  getPackageDetail,
  listPackages,
  publishPackage,
  rejectPackage,
  rollbackPackage,
  updateHotelRate,
  updatePackage,
  validateAndView,
} from './packages.service.js';

export interface RateSheetDeps {
  storage: StorageAdapter;
  /** Absent when no ANTHROPIC_API_KEY is configured. */
  extraction?: ExtractionAdapter;
  /** Tests wait for extraction; production answers at once and reads in the background. */
  inlineJobs: boolean;
  maxUploadBytes: number;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

const UploadFieldsSchema = z.object({
  supplierId: z.string().min(1),
  notes: z.string().trim().max(2000).optional(),
});
const BlankPackageBodySchema = z.object({ packName: z.string().trim().min(1).max(120) });

/** Upload, review and publish: admin and ops (docs/02 section 3). The dashboard uses it too. */
export const RATE_SHEET_ROLES = ['admin', 'ops'] as const;
const ROLES = RATE_SHEET_ROLES;

export function rateSheetAdminRoutes(deps: RateSheetDeps): AdminRoute[] {
  // Held in memory: the file is hashed and checked before it is stored anywhere.
  const receiveFile: RequestHandler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.maxUploadBytes, files: 1, fields: 5 },
  }).single('file');

  const upload = async (req: Request, res: Response) => {
    if (!req.file) {
      throw new HttpError(400, 'validation_error', 'Please check the highlighted fields', {
        file: 'Choose a rate sheet to upload',
      });
    }
    const fields = parseOrThrow(UploadFieldsSchema, req.body);
    const view = await uploadDocument(
      {
        supplierId: fields.supplierId,
        file: req.file.buffer,
        fileName: req.file.originalname,
        notes: fields.notes,
      },
      deps.storage,
      actorOf(req),
    );
    res.status(201).json(view);
  };

  const file = async (req: Request, res: Response) => {
    const { data, mimeType, fileName } = await getDocumentFile(idOf(req), deps.storage);
    res.set({
      'Content-Type': mimeType,
      // Shown inside the review screen; never run as a page of this site.
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.end(data);
  };

  const extract = async (req: Request, res: Response) => {
    const doc = await beginExtraction(idOf(req), deps.extraction);
    const job = completeExtraction(
      doc,
      deps.extraction as ExtractionAdapter,
      deps.storage,
      actorOf(req),
    );
    if (deps.inlineJobs) await job;
    // 202: reading a sheet takes around a minute; the screen polls the document.
    res.status(202).json(await getDocument(idOf(req)));
  };

  const route = (
    method: AdminRoute['method'],
    path: string,
    handler: RequestHandler,
    before?: RequestHandler[],
  ): AdminRoute => ({ method, path, roles: ROLES, handler, before });

  return [
    route('post', '/source-documents', upload, [receiveFile]),
    route('get', '/source-documents', async (req, res) => {
      res.json(await listDocuments(parseOrThrow(ListQuerySchema, req.query)));
    }),
    route('get', '/source-documents/:id', async (req, res) => {
      res.json(await getDocument(idOf(req)));
    }),
    route('get', '/source-documents/:id/file', file),
    route('post', '/source-documents/:id/extract', extract),
    route('post', '/source-documents/:id/rate-packages', async (req, res) => {
      const { packName } = parseOrThrow(BlankPackageBodySchema, req.body);
      res.status(201).json(await createBlankPackage(idOf(req), packName, actorOf(req)));
    }),

    route('get', '/rate-packages', async (req, res) => {
      res.json(await listPackages(parseOrThrow(RatePackageListQuerySchema, req.query)));
    }),
    route('get', '/rate-packages/:id', async (req, res) => {
      res.json(await getPackageDetail(idOf(req)));
    }),
    route('patch', '/rate-packages/:id', async (req, res) => {
      const body = parseOrThrow(UpdateRatePackageBodySchema, req.body);
      res.json(await updatePackage(idOf(req), body, actorOf(req)));
    }),
    route('post', '/rate-packages/:id/validate', async (req, res) => {
      res.json(await validateAndView(idOf(req)));
    }),
    route('post', '/rate-packages/:id/publish', async (req, res) => {
      const { acknowledgeWarnings } = parseOrThrow(PublishBodySchema, req.body ?? {});
      res.json(await publishPackage(idOf(req), acknowledgeWarnings, actorOf(req)));
    }),
    route('post', '/rate-packages/:id/reject', async (req, res) => {
      const { reason } = parseOrThrow(RejectBodySchema, req.body ?? {});
      res.json(await rejectPackage(idOf(req), reason, actorOf(req)));
    }),
    route('post', '/rate-packages/:id/rollback', async (req, res) => {
      res.json(await rollbackPackage(idOf(req), actorOf(req)));
    }),
    route('post', '/rate-packages/:id/hotel-rates', async (req, res) => {
      const body = parseOrThrow(AddHotelRateBodySchema, req.body);
      res.status(201).json(await addHotelRate(idOf(req), body, actorOf(req)));
    }),

    route('patch', '/hotel-rates/:id', async (req, res) => {
      const body = parseOrThrow(UpdateHotelRateBodySchema, req.body);
      res.json(await updateHotelRate(idOf(req), body, actorOf(req)));
    }),
    route('delete', '/hotel-rates/:id', async (req, res) => {
      res.json(await deleteHotelRate(idOf(req), actorOf(req)));
    }),
    route('post', '/hotel-rates/:id/confirm-hotel', async (req, res) => {
      const body = parseOrThrow(ConfirmHotelBodySchema, req.body);
      res.json(await confirmHotel(idOf(req), body, actorOf(req)));
    }),
  ];
}
