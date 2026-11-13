/**
 * PKR / SAR display switch (docs/01 section 3). PKR is the default; the other
 * currency is always shown beside it, so switching only swaps which comes first.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Currency } from './format';

const STORAGE_KEY = 'msf.currency';

interface CurrencyState {
  primary: Currency;
  setPrimary: (currency: Currency) => void;
}

const CurrencyContext = createContext<CurrencyState>({ primary: 'PKR', setPrimary: () => {} });

function stored(): Currency {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'SAR' ? 'SAR' : 'PKR';
  } catch {
    return 'PKR';
  }
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [primary, setState] = useState<Currency>(stored);
  const setPrimary = useCallback((currency: Currency) => {
    setState(currency);
    try {
      window.localStorage.setItem(STORAGE_KEY, currency);
    } catch {
      // the choice just will not persist
    }
  }, []);
  const value = useMemo(() => ({ primary, setPrimary }), [primary, setPrimary]);
  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): CurrencyState {
  return useContext(CurrencyContext);
}
