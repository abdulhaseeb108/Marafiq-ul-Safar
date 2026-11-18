import {
  RATE_SHEET_MAX_BYTES,
  type Paged,
  type SourceDocumentView,
  type SupplierView,
} from '@marafiq/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiRequestError } from './api';
import { useResource } from './useResource';
import { Alert, Button, Field, Note, Section, Select } from './ui';

const POLL_MS = 4000;

export function RateSheetsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { items, error, formErrors, busy, run, reload, setError } = useResource<SourceDocumentView>(
    '/admin/source-documents?limit=50',
  );
  const [suppliers, setSuppliers] = useState<SupplierView[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [manualFor, setManualFor] = useState<{ id: string; packName: string } | null>(null);
  /** Set when an upload was refused because the same file is already here. */
  const [duplicate, setDuplicate] = useState<{
    id: string;
    fileName: string;
    receivedAt: string;
  } | null>(null);
  /** Set when "Enter by hand" was refused because that pack already exists. */
  const [packClash, setPackClash] = useState<{ id: string; packName: string } | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const dates = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  useEffect(() => {
    api<Paged<SupplierView>>('/admin/suppliers?limit=100')
      .then((page) => {
        const active = page.items.filter((supplier) => supplier.active);
        setSuppliers(active);
        setSupplierId((current) => current || (active[0]?.id ?? ''));
      })
      .catch(() => undefined);
  }, []);

  // Reading a sheet takes around a minute: refresh while any is in progress.
  const reading = (items ?? []).some((doc) => doc.extractionStatus === 'extracting');
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [reading, reload]);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    if (file.size > RATE_SHEET_MAX_BYTES) {
      setError(t('admin.errors.file_too_large'));
      return;
    }
    const form = new FormData();
    form.set('supplierId', supplierId);
    form.set('file', file);
    setDuplicate(null);
    setPackClash(null);
    let wasDuplicate = false;
    const ok = await run(async () => {
      try {
        await api('/admin/source-documents', { method: 'POST', form });
      } catch (err) {
        const existing = err instanceof ApiRequestError ? err.fields : undefined;
        if (
          err instanceof ApiRequestError &&
          err.code === 'duplicate_document' &&
          existing?.existingId
        ) {
          wasDuplicate = true;
          setDuplicate({
            id: existing.existingId,
            fileName: existing.existingFileName ?? '',
            receivedAt: existing.existingReceivedAt ?? '',
          });
        }
        throw err;
      }
    });
    // Whether stored or refused as a duplicate, this file needs nothing more.
    if (ok || wasDuplicate) {
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  /** Scroll to the document that already exists and outline it. */
  function showExisting(id: string) {
    setHighlighted(id);
    document.getElementById(`sheet-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const read = (id: string) =>
    run(() => api(`/admin/source-documents/${id}/extract`, { method: 'POST' }));

  async function startManual() {
    if (!manualFor) return;
    setPackClash(null);
    setDuplicate(null);
    let createdId: string | undefined;
    const ok = await run(async () => {
      try {
        const pack = await api<{ id: string }>(
          `/admin/source-documents/${manualFor.id}/rate-packages`,
          { method: 'POST', body: { packName: manualFor.packName } },
        );
        createdId = pack.id;
      } catch (err) {
        const existing = err instanceof ApiRequestError ? err.fields : undefined;
        if (
          err instanceof ApiRequestError &&
          err.code === 'pack_name_taken' &&
          existing?.existingId
        ) {
          setPackClash({ id: existing.existingId, packName: existing.existingPackName ?? '' });
        }
        throw err;
      }
    });
    if (ok && createdId) void navigate(`/admin/rate-sheets/${createdId}`);
  }

  const existingDoc = duplicate ? (items ?? []).find((doc) => doc.id === duplicate.id) : undefined;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">{t('admin.sheets.title')}</h1>
      {error && !duplicate && !packClash && <Alert>{error}</Alert>}

      {duplicate && (
        <div role="alert" className="rounded-md border border-amber-400 bg-amber-50 p-4">
          <p className="font-medium">{t('admin.sheets.duplicateTitle')}</p>
          <p className="mt-1 text-sm">
            {t('admin.sheets.duplicateBody', {
              name: duplicate.fileName,
              date: duplicate.receivedAt ? dates.format(new Date(duplicate.receivedAt)) : '',
            })}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            {existingDoc && (
              <a
                href={`#sheet-${duplicate.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  showExisting(duplicate.id);
                }}
                className="font-medium text-emerald-900 underline"
              >
                {t('admin.sheets.duplicateShow')}
              </a>
            )}
            <a
              href={`/api/v1/admin/source-documents/${duplicate.id}/file`}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-emerald-900 underline"
            >
              {t('admin.sheets.duplicateOpen')}
            </a>
            {existingDoc?.packages.map((pack) => (
              <Link
                key={pack.id}
                to={`/admin/rate-sheets/${pack.id}`}
                className="font-medium text-emerald-900 underline"
              >
                {t('admin.sheets.duplicatePack', { name: pack.packName })}
              </Link>
            ))}
          </div>
        </div>
      )}

      {packClash && (
        <div role="alert" className="rounded-md border border-amber-400 bg-amber-50 p-4">
          <p className="font-medium">
            {t('admin.sheets.packExists', { name: packClash.packName })}
          </p>
          <p className="mt-2 text-sm">
            <Link
              to={`/admin/rate-sheets/${packClash.id}`}
              className="font-medium text-emerald-900 underline"
            >
              {t('admin.sheets.packExistsOpen')}
            </Link>
          </p>
        </div>
      )}

      <Section title={t('admin.sheets.uploadTitle')}>
        {suppliers.length === 0 ? (
          <Note>{t('admin.sheets.needSupplier')}</Note>
        ) : (
          <form onSubmit={upload} className="mt-3 grid gap-4 sm:grid-cols-2" noValidate>
            <Select
              id="sheet-supplier"
              label={t('admin.sheets.supplier')}
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
            >
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </Select>
            <div>
              <label htmlFor="sheet-file" className="block text-sm font-medium">
                {t('admin.sheets.file')}
              </label>
              <input
                id="sheet-file"
                ref={fileInput}
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="mt-1 block min-h-11 w-full rounded-md border border-slate-400 bg-white p-2 text-sm"
              />
              {formErrors.file && <p className="mt-1 text-sm text-red-800">{formErrors.file}</p>}
              <Note>{t('admin.sheets.fileHint')}</Note>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={busy || !file || !supplierId}>
                {t('admin.sheets.upload')}
              </Button>
            </div>
          </form>
        )}
      </Section>

      <Section title={t('admin.sheets.listTitle')}>
        {items === null ? (
          <p className="mt-3">{t('admin.common.loading')}</p>
        ) : items.length === 0 ? (
          <Note>{t('admin.sheets.none')}</Note>
        ) : (
          <ul className="mt-3 space-y-3">
            {items.map((doc) => {
              const isReading = doc.extractionStatus === 'extracting';
              const canRead = !doc.packages.some(
                (pack) => pack.status === 'published' || pack.status === 'superseded',
              );
              return (
                <li
                  key={doc.id}
                  id={`sheet-${doc.id}`}
                  className={`rounded-lg border bg-white p-4 ${
                    highlighted === doc.id
                      ? 'border-amber-500 ring-2 ring-amber-400'
                      : 'border-slate-200'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p dir="ltr" className="text-start font-medium break-all">
                        {doc.fileName}
                      </p>
                      <p className="text-sm text-slate-700">
                        {doc.supplierName} · {dates.format(new Date(doc.receivedAt))}
                        {doc.uploadedByName && ` · ${doc.uploadedByName}`}
                      </p>
                      <p className="mt-1 text-sm">
                        {t(`admin.sheets.status.${doc.extractionStatus}`)}
                      </p>
                      {doc.extractionError && (
                        <p role="alert" className="mt-1 text-sm text-red-800">
                          {t('admin.sheets.readFailed')}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={`/api/v1/admin/source-documents/${doc.id}/file`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-11 items-center rounded-md border border-slate-400 bg-white px-4 text-sm font-medium hover:bg-slate-100"
                      >
                        {t('admin.sheets.viewOriginal')}
                      </a>
                      {canRead && (
                        <>
                          <Button disabled={busy || isReading} onClick={() => void read(doc.id)}>
                            {t(
                              doc.packages.length > 0 || doc.extractionError
                                ? 'admin.sheets.readAgain'
                                : 'admin.sheets.read',
                            )}
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={busy || isReading}
                            onClick={() => setManualFor({ id: doc.id, packName: '' })}
                          >
                            {t('admin.sheets.enterByHand')}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {manualFor?.id === doc.id && (
                    <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-200 pt-4">
                      <div className="min-w-56 flex-1">
                        <Field
                          id={`manual-${doc.id}`}
                          label={t('admin.sheets.packName')}
                          value={manualFor.packName}
                          onChange={(e) => setManualFor({ ...manualFor, packName: e.target.value })}
                        />
                      </div>
                      <Button
                        disabled={busy || manualFor.packName.trim() === ''}
                        onClick={() => void startManual()}
                      >
                        {t('admin.sheets.startPack')}
                      </Button>
                      <Button variant="secondary" onClick={() => setManualFor(null)}>
                        {t('admin.common.cancel')}
                      </Button>
                    </div>
                  )}

                  {doc.packages.length > 0 && (
                    <ul className="mt-4 space-y-2 border-t border-slate-200 pt-3">
                      {doc.packages.map((pack) => (
                        <li
                          key={pack.id}
                          className="flex flex-wrap items-center justify-between gap-2"
                        >
                          <div className="text-sm">
                            <Link
                              to={`/admin/rate-sheets/${pack.id}`}
                              className="font-medium text-emerald-900 underline"
                            >
                              {pack.packName}
                            </Link>
                            <span dir="ltr" className="ms-2 text-slate-700">
                              {pack.nightFrom ?? '?'} → {pack.nightTo ?? '?'}
                            </span>
                            <span className="ms-2 text-slate-700">
                              · {t(`admin.pack.status.${pack.status}`)} · v{pack.version}
                            </span>
                          </div>
                          <p className="text-sm">
                            {pack.blockingCount > 0 && (
                              <span className="me-2 rounded bg-red-100 px-2 py-0.5 text-red-900">
                                {t('admin.pack.blockingCount', { count: pack.blockingCount })}
                              </span>
                            )}
                            {pack.warningCount > 0 && (
                              <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-900">
                                {t('admin.pack.warningCount', { count: pack.warningCount })}
                              </span>
                            )}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
