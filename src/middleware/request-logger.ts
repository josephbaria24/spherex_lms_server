import type { IncomingMessage, ServerResponse } from "node:http";
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { pinoHttp } from "pino-http";
import { logger } from "../lib/logger.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export const requestLogger = pinoHttp({
  logger,
  genReqId(req: IncomingMessage, res: ServerResponse) {
    const incoming = req.headers["x-request-id"];
    const id =
      typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID();
    res.setHeader("x-request-id", id);
    return id;
  },
  customProps(req) {
    return {
      requestId: req.id,
    };
  },
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  serializers: {
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url,
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
      };
    },
  },
});

/** Attach req.requestId for handlers that don't use pino-http's req.id */
export function attachRequestId(req: Request, _res: Response, next: NextFunction) {
  req.requestId = typeof req.id === "string" ? req.id : undefined;
  next();
}
