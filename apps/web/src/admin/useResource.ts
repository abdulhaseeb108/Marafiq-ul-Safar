import type { Paged } from '@marafiq/shared';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { errorText, fieldErrors } from './ui';

/**
 * Loads a list from the API and runs changes against it. Every change reloads
 * from the server rather than patching local state, so what is on screen is
 * what the API actually stored.
 */
export function useResource<T>(path: string) {
  const { t } = useTranslation();
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const page = await api<Paged<T>>(path);
      setItems(page.items);
    } catch (err) {
      setError(errorText(err, t));
    }
  }, [path, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Runs one request, then reloads. Returns true when it succeeded, so a form
   * can clear itself only if the change actually went through.
   */
  const run = useCallback(
    async (request: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      setFormErrors({});
      try {
        await request();
        await reload();
        return true;
      } catch (err) {
        setError(errorText(err, t));
        setFormErrors(fieldErrors(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [reload, t],
  );

  return { items, error, formErrors, busy, reload, run, setError };
}
