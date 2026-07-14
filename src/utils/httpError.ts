export class HttpError extends Error {
  public readonly status: number;
  public readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }

  static badRequest(message = "Bad request", details?: unknown) {
    return new HttpError(400, message, details);
  }
  static unauthorized(message = "Unauthorized") {
    return new HttpError(401, message);
  }
  static forbidden(message = "Forbidden") {
    return new HttpError(403, message);
  }
  static notFound(message = "Not found") {
    return new HttpError(404, message);
  }
  static conflict(message = "Conflict") {
    return new HttpError(409, message);
  }
  static paymentRequired(message = "Payment required", details?: unknown) {
    return new HttpError(402, message, details);
  }
}
