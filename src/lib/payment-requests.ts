import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getUploadsRoot } from "./org-uploads.js";

const TXN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateUploadToken(): string {
  return randomBytes(32).toString("hex");
}

export function generateTempPassword(length = 12): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

export function generateTransactionNumber(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    suffix += TXN_CHARS[Math.floor(Math.random() * TXN_CHARS.length)];
  }
  return `SPX-${y}${m}${day}-${suffix}`;
}

export function initReceiptUploadsDirectory(): string {
  const dir = join(getUploadsRoot(), "receipts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function receiptPublicPath(filename: string): string {
  return `/uploads/receipts/${filename}`;
}
