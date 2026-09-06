export function httpError(statusCode, message, options = {}) {
  const error = new Error(message, options);
  error.statusCode = statusCode;
  return error;
}
