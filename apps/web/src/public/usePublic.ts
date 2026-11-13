/**
 * Read-only public API data (config, hotels), cached for the page session so
 * moving between pages does not refetch.
 */
import type { PublicConfig, PublicHotel } from '@marafiq/shared';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const cache = new Map<string, Promise<unknown>>();

function load<T>(path: string): Promise<T> {
  let pending = cache.get(path) as Promise<T> | undefined;
  if (!pending) {
    pending = api<T>(path, { retryOn401: false });
    cache.set(path, pending);
    // A failed request is not kept, so the next visit tries again.
    pending.catch(() => cache.delete(path));
  }
  return pending;
}

/** For tests: forget everything fetched so far. */
export function clearPublicCache(): void {
  cache.clear();
}

export type Loadable<T> =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T };

export function usePublic<T>(path: string): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    load<T>(path).then(
      (data) => live && setState({ status: 'ready', data }),
      () => live && setState({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [path]);
  return state;
}

export const usePublicConfig = () => usePublic<PublicConfig>('/public/config');
export const usePublicHotels = () => usePublic<{ items: PublicHotel[] }>('/public/hotels');
