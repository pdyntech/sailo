/**
 * Checks the SMTP settings before they go live: logs in to the mail server and sends one test email.
 * Run: npm run check-mail -- you@example.com   (reads SMTP_URL and MAIL_FROM from .env.local; never prints them)
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

const envFile = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const to = process.argv[2];
const url = process.env.SMTP_URL?.trim();
const from = process.env.MAIL_FROM?.trim() || "Sailo <no-reply@sailo.local>";

if (!to) {
  console.error("Usage: npm run check-mail -- you@example.com");
  process.exit(1);
}
if (!url) {
  console.error("SMTP_URL is not set in .env.local");
  process.exit(1);
}

try {
  const transport = nodemailer.createTransport(url);
  await transport.verify();
  console.log(`OK  logged in to ${new URL(url).hostname}`);
  await transport.sendMail({ from, to, subject: "Sailo email test", text: "If you can read this, Sailo's email settings work." });
  console.log(`OK  test email sent from ${from} to ${to}. Check the inbox (and spam).`);
} catch (e) {
  console.error(`FAIL ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
