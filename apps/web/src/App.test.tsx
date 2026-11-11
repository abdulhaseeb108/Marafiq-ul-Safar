import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import i18n from './i18n';
import en from './locales/en.json';
import ur from './locales/ur.json';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

const renderHome = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>,
  );

describe('hello page', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders in English, left to right', () => {
    renderHome();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(en.hello.title);
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
  });

  it('switches to Urdu with dir="rtl" and back again', async () => {
    const user = userEvent.setup();
    renderHome();

    await user.click(screen.getByRole('button', { name: 'اردو' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(ur.hello.title);
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ur');
    expect(screen.getByRole('button', { name: 'اردو' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'English' }));
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('has the same translation keys in both languages', () => {
    const urKeys = leafKeys(ur).filter((key) => key !== '_review');
    expect(urKeys.sort()).toEqual(leafKeys(en).sort());
  });
});
