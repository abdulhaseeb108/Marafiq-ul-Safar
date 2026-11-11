import type { LoginResponse, TwoFactorEnrollResponse } from '@marafiq/shared';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate } from 'react-router-dom';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { api } from './api';
import { useAuth } from './AuthContext';
import { Alert, Button, Field, errorText } from './ui';

type Step = 'password' | '2fa' | 'enroll_2fa';

export function LoginPage() {
  const { t } = useTranslation();
  const { state, setUser } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState<(TwoFactorEnrollResponse & { qr: string }) | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Admins without 2FA: fetch a new secret and draw its QR code in the browser.
  useEffect(() => {
    if (step !== 'enroll_2fa' || enrollment) return;
    let cancelled = false;
    api<TwoFactorEnrollResponse>('/auth/2fa/enroll', { method: 'POST', retryOn401: false })
      .then(async (data) => {
        const qr = await QRCode.toDataURL(data.otpauthUrl, { margin: 1, width: 220 });
        if (!cancelled) setEnrollment({ ...data, qr });
      })
      .catch((err: unknown) => !cancelled && setError(errorText(err, t)));
    return () => {
      cancelled = true;
    };
  }, [step, enrollment, t]);

  if (state.status === 'authenticated') return <Navigate to="/admin" replace />;

  function finish(result: LoginResponse) {
    if (result.next === 'done' && result.user) {
      setUser(result.user);
      void navigate('/admin', { replace: true });
    } else if (result.next !== 'done') {
      setStep(result.next);
    }
  }

  async function submit(event: FormEvent, request: () => Promise<LoginResponse>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      finish(await request());
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  const submitPassword = (event: FormEvent) =>
    submit(event, () =>
      api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { email, password },
        retryOn401: false,
      }),
    );

  const submitCode = (event: FormEvent) =>
    submit(event, () =>
      api<LoginResponse>('/auth/2fa', { method: 'POST', body: { code }, retryOn401: false }),
    );

  function startOver() {
    setStep('password');
    setPassword('');
    setCode('');
    setEnrollment(null);
    setError(null);
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8 text-slate-900">
      <div className="mx-auto max-w-sm">
        <div className="flex items-center justify-between gap-3">
          <p className="text-lg font-semibold">{t('app.name')}</p>
          <LanguageSwitch />
        </div>

        <main className="mt-6 rounded-lg border border-slate-200 bg-white p-5">
          {step === 'password' ? (
            <form onSubmit={submitPassword} className="space-y-4" noValidate>
              <h1 className="text-xl font-bold">{t('admin.login.title')}</h1>
              {error && <Alert>{error}</Alert>}
              <Field
                id="email"
                type="email"
                label={t('admin.login.email')}
                autoComplete="username"
                dir="ltr"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Field
                id="password"
                type="password"
                label={t('admin.login.password')}
                autoComplete="current-password"
                dir="ltr"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <Button type="submit" disabled={busy} className="w-full">
                {t('admin.login.submit')}
              </Button>
            </form>
          ) : (
            <form onSubmit={submitCode} className="space-y-4" noValidate>
              <h1 className="text-xl font-bold">
                {t(step === '2fa' ? 'admin.twoFactor.title' : 'admin.twoFactor.setupTitle')}
              </h1>
              {error && <Alert>{error}</Alert>}

              {step === 'enroll_2fa' && (
                <div className="space-y-3">
                  <p className="text-sm">{t('admin.twoFactor.setupIntro')}</p>
                  {enrollment ? (
                    <>
                      <img
                        src={enrollment.qr}
                        alt={t('admin.twoFactor.qrAlt')}
                        width={220}
                        height={220}
                        className="mx-auto"
                      />
                      <p className="text-sm">{t('admin.twoFactor.manualKey')}</p>
                      <p dir="ltr" className="break-all rounded bg-slate-100 p-2 font-mono text-sm">
                        {enrollment.secret}
                      </p>
                    </>
                  ) : (
                    !error && <p className="text-sm">{t('admin.common.loading')}</p>
                  )}
                </div>
              )}

              <Field
                id="code"
                label={t('admin.twoFactor.code')}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                dir="ltr"
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
              <Button type="submit" disabled={busy || code.length !== 6} className="w-full">
                {t('admin.twoFactor.submit')}
              </Button>
              <Button variant="secondary" onClick={startOver} className="w-full">
                {t('admin.twoFactor.back')}
              </Button>
            </form>
          )}
        </main>
      </div>
    </div>
  );
}
