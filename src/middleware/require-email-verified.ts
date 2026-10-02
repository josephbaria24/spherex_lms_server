import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../utils/httpError.js";
import { assertEmailVerified } from "../lib/email-verification.js";

export async function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(HttpError.unauthorized());
    return;
  }
  try {
    await assertEmailVerified(req.user.sub, req.user.role);
    next();
  } catch (err) {
    next(err);
  }
}

/** Guest checkout stays open; signed-in students must verify first. */
export async function requireVerifiedEmailIfAuthed(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  if (!req.user) {
    next();
    return;
  }
  try {
    await assertEmailVerified(req.user.sub, req.user.role);
    next();
  } catch (err) {
    next(err);
  }
}
