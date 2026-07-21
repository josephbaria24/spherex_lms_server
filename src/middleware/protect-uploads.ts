import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../utils/httpError.js";
import { isAdmin } from "../lib/roles.js";

/**
 * Static uploads under /api/uploads:
 * - org logos / course covers: public (used on landing)
 * - receipts: admin only
 * - SCORM / lesson videos: authenticated users
 */
export function protectUploads(req: Request, _res: Response, next: NextFunction) {
  const path = (req.path || "").replace(/^\/+/, "");
  const first = path.split("/")[0] ?? "";

  if (first === "organizations" || first === "courses") {
    next();
    return;
  }

  if (first === "receipts") {
    if (!req.user) {
      next(HttpError.unauthorized());
      return;
    }
    if (!isAdmin(req.user.role)) {
      next(HttpError.forbidden());
      return;
    }
    next();
    return;
  }

  if (!req.user) {
    next(HttpError.unauthorized());
    return;
  }

  next();
}
