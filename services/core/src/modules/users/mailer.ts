import { Inject, Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

export const MAIL_TRANSPORT = Symbol('oe:core:mail-transport');

/** SMTP transport for invite emails. `SMTP_URL` defaults to the dev Mailpit listener. */
export function createMailTransport(): Transporter {
  return nodemailer.createTransport(process.env.SMTP_URL ?? 'smtp://localhost:1025');
}

@Injectable()
export class InviteMailer {
  constructor(@Inject(MAIL_TRANSPORT) private readonly transport: Transporter) {}

  /** Sends the acceptance link to `admin-web /[locale]/invite/{token}`. */
  async sendInvite(params: { to: string; token: string; locale: string }): Promise<void> {
    const base = process.env.ADMIN_WEB_URL ?? 'http://localhost:3000';
    const link = `${base}/${params.locale}/invite/${params.token}`;
    await this.transport.sendMail({
      from: process.env.SMTP_FROM ?? 'no-reply@open-emarsys.local',
      to: params.to,
      subject: "You've been invited to open-emarsys",
      text: `You've been invited to open-emarsys. Set your password: ${link}`,
      html: `<p>You've been invited to open-emarsys.</p><p><a href="${link}">Set your password</a></p>`,
    });
  }
}
