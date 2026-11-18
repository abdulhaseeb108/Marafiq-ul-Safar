/**
 * Email text for customers (in their language) and staff. Plain text only.
 * Urdu wording is an AI draft and needs native review (docs/05 #15).
 * Sending never blocks the request: a failed email is logged by kind only.
 */
import type { Language } from '@marafiq/shared';
import type { EmailAdapter, EmailMessage } from '../../adapters/email/email.js';
import { errorName, log } from '../../lib/logger.js';
import { reportError } from '../../lib/monitoring.js';

const KARACHI = { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' } as const;

function when(at: Date, language: Language): string {
  return new Intl.DateTimeFormat(language === 'ur' ? 'ur-PK' : 'en-GB', {
    ...KARACHI,
    numberingSystem: 'latn',
  }).format(at);
}

export function inquiryAck(
  to: string,
  language: Language,
  reference: string,
  responseTimeText: string,
): EmailMessage {
  if (language === 'ur') {
    return {
      to,
      kind: 'inquiry.ack',
      subject: `آپ کی درخواست موصول ہو گئی — ${reference}`,
      text: [
        'السلام علیکم،',
        '',
        `آپ کی کوٹیشن کی درخواست ہمیں مل گئی ہے۔ آپ کا ریفرنس نمبر ${reference} ہے۔`,
        responseTimeText,
        '',
        'ریٹس بغیر اطلاع کے تبدیل ہو سکتے ہیں۔ یہ بکنگ نہیں ہے۔',
        '',
        'مرافق السفر',
      ].join('\n'),
    };
  }
  return {
    to,
    kind: 'inquiry.ack',
    subject: `We have your request — ${reference}`,
    text: [
      'Assalamu alaikum,',
      '',
      `Thank you. We have your quote request. Your reference is ${reference}.`,
      responseTimeText,
      '',
      'Rates can change without notice. This is not a booking.',
      '',
      'Marafiq Us Safar',
    ].join('\n'),
  };
}

export function quoteSent(
  to: string,
  language: Language,
  reference: string,
  version: number,
  link: string,
  expiresAt: Date,
): EmailMessage {
  if (language === 'ur') {
    return {
      to,
      kind: 'quote.sent',
      subject: `آپ کی کوٹیشن تیار ہے — ${reference}`,
      text: [
        'السلام علیکم،',
        '',
        `آپ کی کوٹیشن (ورژن ${version}) یہاں دیکھیں:`,
        link,
        '',
        `یہ ${when(expiresAt, language)} (پاکستانی وقت) تک کارآمد ہے۔ ریٹس بغیر اطلاع کے تبدیل ہو سکتے ہیں۔`,
        'یہ لنک صرف آپ کے لیے ہے؛ اسے کسی کو نہ بھیجیں۔',
        '',
        'مرافق السفر',
      ].join('\n'),
    };
  }
  return {
    to,
    kind: 'quote.sent',
    subject: `Your quote is ready — ${reference}`,
    text: [
      'Assalamu alaikum,',
      '',
      `Your quote (version ${version}) is here:`,
      link,
      '',
      `It is valid until ${when(expiresAt, language)} (Pakistan time). Rates can change without notice.`,
      'This link is for you only; please do not share it.',
      '',
      'Marafiq Us Safar',
    ].join('\n'),
  };
}

/** Staff notices carry the reference and a link to the admin page; no customer details. */
export function staffNotice(
  to: string,
  kind: 'staff.new_inquiry' | 'staff.quote_accepted' | 'staff.question',
  reference: string,
  adminLink: string,
): EmailMessage {
  const subject = {
    'staff.new_inquiry': `New inquiry ${reference}`,
    'staff.quote_accepted': `Quote accepted ${reference}`,
    'staff.question': `New question on ${reference}`,
  }[kind];
  return { to, kind, subject, text: `${subject}\n\nOpen it: ${adminLink}` };
}

/** Send without failing the request. Logs the kind only, never the address. */
export async function sendQuietly(email: EmailAdapter, message: EmailMessage): Promise<boolean> {
  try {
    await email.send(message);
    return true;
  } catch (error) {
    // Kind and error class only: a provider's message can quote the address.
    log.error('email failed', { kind: message.kind, error: errorName(error) });
    reportError(error, { area: 'email', kind: message.kind });
    return false;
  }
}
