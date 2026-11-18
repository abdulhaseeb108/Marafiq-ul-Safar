import { log } from '../../lib/logger.js';

/**
 * Outgoing email (docs/02 section 5). The app only depends on this interface:
 * Resend in production, a log-only stand-in in development, memory in tests.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Short label for logs, e.g. "inquiry.ack". Never personal data. */
  kind: string;
}

export interface EmailAdapter {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/** Development: prints that an email would be sent, without the address or body. */
export class LogEmail implements EmailAdapter {
  readonly name = 'log only (no RESEND_API_KEY)';
  async send(message: EmailMessage): Promise<void> {
    log.info('email not sent (log-only adapter)', {
      kind: message.kind,
      subject: message.subject,
    });
  }
}

/** Tests: keeps what was sent. */
export class MemoryEmail implements EmailAdapter {
  readonly name = 'memory';
  readonly sent: EmailMessage[] = [];
  /** Set to make the next sends fail. */
  failing = false;
  async send(message: EmailMessage): Promise<void> {
    if (this.failing) throw new Error('email failed');
    this.sent.push(message);
  }
}

/** Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendEmail implements EmailAdapter {
  readonly name = 'Resend';
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Resend answered ${response.status}`);
  }
}
