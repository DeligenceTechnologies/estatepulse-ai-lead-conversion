import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { MailService } from './mail.service';

/**
 * The transport is mocked, not the service. What is worth pinning here is the
 * message that would go out — it carries a password, so its contents are the
 * whole feature — and the two ways a send can fail to happen.
 */
const sendMail = vi.fn();

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: (...a: unknown[]) => sendMail(...a) })) },
}));

const configOf = (env: Record<string, string>): ConfigService =>
  ({ get: (key: string) => env[key] }) as unknown as ConfigService;

const WELCOME = {
  to: 'new.agent@example.test',
  firstName: 'Nia',
  organizationName: 'Org A Realty',
  password: 'correct-horse-battery-staple',
  signInUrl: 'https://app.example.test/login',
};

beforeEach(() => {
  sendMail.mockReset();
  sendMail.mockResolvedValue({ messageId: 'x' });
  vi.mocked(nodemailer.createTransport).mockClear();
});

describe('MailService — disabled', () => {
  it('is off when SMTP_HOST is absent, which is the normal state', () => {
    const mail = new MailService(configOf({}));

    expect(mail.enabled).toBe(false);
    // No transport is even built, so a missing config cannot become a runtime
    // connection attempt on the first send.
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('reports not-sent with a reason rather than throwing', async () => {
    const mail = new MailService(configOf({}));

    const result = await mail.sendAgentWelcome(WELCOME);

    // The caller has already committed a database write by this point; a throw
    // here would turn a created agent into a failed request.
    expect(result.sent).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('MailService — configured', () => {
  it('builds the transport from the environment', () => {
    const mail = new MailService(
      configOf({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p' }),
    );

    expect(mail.enabled).toBe(true);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        auth: { user: 'u', pass: 'p' },
      }),
    );
  });

  it('treats port 465 as implicit TLS without being told', () => {
    new MailService(configOf({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465' }));

    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: true }),
    );
  });

  it('omits auth entirely when there are no credentials', () => {
    // Passing `auth: { user: undefined }` makes nodemailer attempt an AUTH the
    // server may not offer.
    new MailService(configOf({ SMTP_HOST: 'smtp.example.test' }));

    const options = vi.mocked(nodemailer.createTransport).mock.calls[0][0] as Record<string, unknown>;
    expect('auth' in options).toBe(false);
  });

  it('sends the agent their address and password', async () => {
    const mail = new MailService(
      configOf({ SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'noreply@example.test' }),
    );

    const result = await mail.sendAgentWelcome(WELCOME);

    expect(result).toEqual({ sent: true });
    const message = sendMail.mock.calls[0][0] as Record<string, string>;
    expect(message['to']).toBe(WELCOME.to);
    expect(message['from']).toBe('noreply@example.test');
    expect(message['subject']).toContain('Org A Realty');
    // Both alternatives carry the credentials, because a client may render
    // either one.
    expect(message['text']).toContain(WELCOME.password);
    expect(message['html']).toContain(WELCOME.password);
    expect(message['text']).toContain(WELCOME.to);
    expect(message['text']).toContain(WELCOME.signInUrl);
  });

  it('falls back to SMTP_USER as the From address', async () => {
    const mail = new MailService(configOf({ SMTP_HOST: 'smtp.example.test', SMTP_USER: 'bot@example.test', SMTP_PASS: 'p' }));

    await mail.sendAgentWelcome(WELCOME);

    expect((sendMail.mock.calls[0][0] as Record<string, string>)['from']).toBe('bot@example.test');
  });

  it('omits the sign-in link when no app URL is configured', async () => {
    const mail = new MailService(configOf({ SMTP_HOST: 'smtp.example.test' }));

    await mail.sendAgentWelcome({ ...WELCOME, signInUrl: null });

    const message = sendMail.mock.calls[0][0] as Record<string, string>;
    expect(message['text']).not.toContain('Sign in:');
    expect(message['html']).not.toContain('<a href');
  });

  it('escapes the password in the HTML alternative', async () => {
    const mail = new MailService(configOf({ SMTP_HOST: 'smtp.example.test' }));

    // A password is whatever someone typed, and it lands inside a tag.
    await mail.sendAgentWelcome({ ...WELCOME, password: '<script>alert(1)</script>' });

    const message = sendMail.mock.calls[0][0] as Record<string, string>;
    expect(message['html']).not.toContain('<script>');
    expect(message['html']).toContain('&lt;script&gt;');
    // The plain-text alternative is not markup and must stay verbatim, or the
    // password the agent copies is not the one that was set.
    expect(message['text']).toContain('<script>alert(1)</script>');
  });

  it('reports a failed send without leaking the SMTP error', async () => {
    const mail = new MailService(configOf({ SMTP_HOST: 'smtp.example.test' }));
    sendMail.mockRejectedValueOnce(new Error('535 auth failed for user bot@example.test'));

    const result = await mail.sendAgentWelcome(WELCOME);

    expect(result.sent).toBe(false);
    // This string reaches a browser; an SMTP error can name the host, the
    // account and occasionally the credential.
    expect(result.reason).not.toContain('535');
    expect(result.reason).not.toContain('bot@example.test');
  });
});
