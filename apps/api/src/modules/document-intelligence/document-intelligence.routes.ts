import type { Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { StorageAdapter } from '../../adapters/storage/storage.js';
import { actorOf } from '../../lib/actor.js';
import type { AdminRoute } from '../../lib/admin-route.js';
import { HttpError } from '../../lib/http-error.js';
import { parseOrThrow } from '../../lib/validate.js';
import type { DocumentParserLimits } from './document-parser-limits.js';
import {
  getDocumentIntelligenceFile,
  getDocumentProcessingStatus,
  listDocumentEvidence,
  retryDocumentProcessing,
  uploadIntelligenceDocument,
} from './documents.service.js';

const UploadFieldsSchema = z.object({
  supplierId: z.string().min(1),
  notes: z.string().trim().max(2000).optional(),
});
const EvidenceQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export interface DocumentIntelligenceRouteDeps {
  storage: StorageAdapter;
  limits: DocumentParserLimits;
  maxConcurrentUploads: number;
}

const ROLES = ['admin', 'ops'] as const;

export function documentIntelligenceAdminRoutes(deps: DocumentIntelligenceRouteDeps): AdminRoute[] {
  let activeUploads = 0;
  const limitConcurrentUploads: RequestHandler = (_req, _res, next) => {
    if (activeUploads >= deps.maxConcurrentUploads) {
      next(new HttpError(503, 'upload_capacity', 'Document upload capacity is temporarily full.'));
      return;
    }
    activeUploads += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeUploads -= 1;
    };
    _res.once('finish', release);
    _res.once('close', release);
    next();
  };
  const receiveFile: RequestHandler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.limits.maxFileBytes, files: 1, fields: 5 },
  }).single('file');
  const idOf = (req: Request) => String(req.params.id ?? '');
  const route = (
    method: AdminRoute['method'],
    path: string,
    handler: RequestHandler,
    before?: RequestHandler[],
  ): AdminRoute => ({ method, path, roles: ROLES, handler, before });

  const upload = async (req: Request, res: Response) => {
    if (!req.file) {
      throw new HttpError(400, 'validation_error', 'Choose a supplier document to upload.', {
        file: 'A file is required',
      });
    }
    const fields = parseOrThrow(UploadFieldsSchema, req.body);
    const result = await uploadIntelligenceDocument(
      {
        supplierId: fields.supplierId,
        file: req.file.buffer,
        fileName: req.file.originalname,
        notes: fields.notes,
      },
      deps.storage,
      actorOf(req),
      deps.limits,
    );
    res.status(201).json(result);
  };

  return [
    route('post', '/document-intelligence/source-documents', upload, [
      limitConcurrentUploads,
      receiveFile,
    ]),
    route('get', '/document-intelligence/source-documents/:id/file', async (req, res) => {
      const file = await getDocumentIntelligenceFile(idOf(req), deps.storage);
      res.set({
        'Content-Type': file.mimeType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      });
      res.end(file.data);
    }),
    route('get', '/document-intelligence/source-documents/:id/processing', async (req, res) => {
      res.json(await getDocumentProcessingStatus(idOf(req)));
    }),
    route('get', '/document-intelligence/source-documents/:id/evidence', async (req, res) => {
      const query = parseOrThrow(EvidenceQuerySchema, req.query);
      res.json(await listDocumentEvidence(idOf(req), query.page, query.limit));
    }),
    route('post', '/document-intelligence/source-documents/:id/retry', async (req, res) => {
      res.status(202).json({ processing: await retryDocumentProcessing(idOf(req)) });
    }),
  ];
}
