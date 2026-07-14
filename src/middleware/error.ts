import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../utils/httpError.js";
import { isProd } from "../config/env.js";

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: "Not found" });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  // eslint-disable-next-line no-console
  console.error("[unhandled]", err);

  const message =
    err instanceof Error ? err.message : "Internal server error";

  res.status(500).json({
    error: "Internal server error",
    ...(isProd ? {} : { detail: message }),
  });
}
