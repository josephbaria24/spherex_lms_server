import nodemailer from "nodemailer";
import { env } from "../config/env.js";

export type SendMailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

function smtpConfigured(): boolean {
  return Boolean(env.smtp.host && env.smtp.user && env.smtp.pass && env.smtp.fromEmail);
}

function createTransport() {
  return nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465,
    auth: {
      user: env.smtp.user,
      pass: env.smtp.pass,
    },
  });
}

export async function sendMail(input: SendMailInput): Promise<{ sent: boolean; skipped?: boolean }> {
  if (!smtpConfigured()) {
    // eslint-disable-next-line no-console
    console.warn("[mailer] SMTP not configured — skipping email:", input.subject, "→", input.to);
    return { sent: false, skipped: true };
  }

  const transport = createTransport();
  const from = `"${env.smtp.fromName}" <${env.smtp.fromEmail}>`;

  await transport.sendMail({
    from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html ?? input.text.replace(/\n/g, "<br/>"),
  });

  return { sent: true };
}

export function appUrl(path: string): string {
  const base = env.clientOrigin.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}
