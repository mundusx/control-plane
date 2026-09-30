export function httpError(statusCode, message, options = {}) {
  const error = new Error(message, options);
  error.statusCode = statusCode;
  return error;
}

// Exception text can contain database URLs, upstream tokens, or host paths.
// Use fixed public messages even when a dependency sets statusCode itself.
export function publicErrorMessage(error) {
  return ({400: 'Invalid request', 401: 'Authentication required', 403: 'Access denied',
    404: 'Not found', 405: 'Method not allowed', 409: 'Request conflicts with current state',
    410: 'Result expired', 413: 'Request too large', 415: 'Unsupported content type',
    422: 'Invalid request', 429: 'Too many requests; try again shortly'})[error?.statusCode]
    ?? 'Request failed; please try again';
}
