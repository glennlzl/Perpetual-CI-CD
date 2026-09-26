/** An error the router answers with its HTTP status and message. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Refuses the request with 400 unless condition holds. */
export function check(condition, message) {
  if (!condition) throw new HttpError(400, message);
}

/** Answers 404. */
export function notFound(message) {
  throw new HttpError(404, message);
}
