import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod";
import { HttpError } from "../utils/httpError.js";

type Source = "body" | "query" | "params";

export const validate =
  <T>(schema: ZodSchema<T>, source: Source = "body") =>
  (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(HttpError.badRequest("Validation failed", result.error.flatten()));
    }
    // Attach a normalised `validated` payload so handlers can read typed data
    // without mutating the original request property.
    (req as Request & { validated?: unknown }).validated = result.data;
    next();
  };
