import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import { verifySession, type SessionPayload } from "../utils/jwt.js";
import { isAdmin, isTeacher } from "../lib/roles.js";

export { isSuperAdmin } from "../lib/org-helpers.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionPayload;
    }
  }
}

function extractToken(req: Request): string | null {
  const cookieToken = req.cookies?.[env.cookie.name];
  if (typeof cookieToken === "string" && cookieToken.length > 0) {
    return cookieToken;
  }
  const header = req.headers.authorization;
  if (header && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return null;
}

export function attachUser(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return next();
  try {
    req.user = verifySession(token);
  } catch {
    // Invalid token: leave req.user unset; downstream guards will 401.
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(HttpError.unauthorized());
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(HttpError.unauthorized());
  if (!isAdmin(req.user.role)) return next(HttpError.forbidden("Admin only"));
  next();
}

/** Platform super admin (same as requireAdmin; alias for org tenancy docs). */
export const requireSuperAdmin = requireAdmin;

export function requireTeacher(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(HttpError.unauthorized());
  if (!isTeacher(req.user.role) && !isAdmin(req.user.role)) {
    return next(HttpError.forbidden("Teacher only"));
  }
  next();
}
