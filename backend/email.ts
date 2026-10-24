import nodemailer from "nodemailer";

export type VerificationMailer = (email: string, verificationUrl: string) => Promise<void>;

export function createVerificationMailer(): VerificationMailer {
  const mode = process.env.EMAIL_DELIVERY_MODE?.trim().toLowerCase() || "smtp";
  if (mode === "console") {
    if (process.env.NODE_ENV === "production") throw new Error("console_email_delivery_disabled_in_production");
    return async (email, verificationUrl) => {
      console.info(`[development email] verification message addressed to ${email}: ${verificationUrl}`);
    };
  }
  if (mode !== "smtp") throw new Error("invalid_email_delivery_mode");
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM?.trim();
  if (!host || !Number.isInteger(port) || !user || !pass || !from) throw new Error("smtp_not_configured");
  const transport = nodemailer.createTransport({ host, port, secure: process.env.SMTP_SECURE === "true", auth: { user, pass } });
  return async (email, verificationUrl) => {
    await transport.sendMail({
      from,
      to: email,
      subject: "Verify your EventRent email",
      text: `Verify your EventRent email by opening this link: ${verificationUrl}\n\nThis link expires soon and can only be used once.`,
      html: `<p>Verify your EventRent email to continue.</p><p><a href="${verificationUrl}">Verify email</a></p><p>This link expires soon and can only be used once.</p>`,
    });
  };
}
