import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../config/env.js";

export interface SessionPayload {
  sub: string;
  email: string;
  role: "admin" | "teacher" | "student" | "user";
}

export function signSession(payload: SessionPayload): string {
  const options: SignOptions = {
    expiresIn: env.jwt.expiresIn as SignOptions["expiresIn"],
  };
  return jwt.sign(payload, env.jwt.secret, options);
}

export function verifySession(token: string): SessionPayload {
  const decoded = jwt.verify(token, env.jwt.secret);
  if (typeof decoded === "string") {
    throw new Error("Invalid session token");
  }
  const payload = decoded as Partial<SessionPayload>;
  if (!payload.sub || !payload.email || !payload.role) {
    throw new Error("Invalid session payload");
  }
  return {
    sub: payload.sub,
    email: payload.email,
    role: payload.role,
  };
}
