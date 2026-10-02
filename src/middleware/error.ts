import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../utils/httpError.js";
import { isProd } from "../config/env.js";
import { logger } from "../lib/logger.js";

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: "Not found" });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  logger.error(
    { err, requestId: req.requestId ?? req.id },
    "unhandled error",
  );

  const message =
    err instanceof Error ? err.message : "Internal server error";

  res.status(500).json({
    error: "Internal server error",
    ...(isProd ? {} : { detail: message }),
  });
}
