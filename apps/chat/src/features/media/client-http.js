import { httpError } from '../../shared/http-error.js';

export function createMediaClientHttpController({ service, authStore, readJsonBody, sendJson }) {
  return async ({ request, response, url }) => {
    const match = url.pathname.match(/^\/v1\/media\/jobs(?:\/([0-9a-f-]{36})(\/result)?)?$/);
    const profiles = url.pathname === '/v1/media/profiles';
    if (!match && !profiles) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    const session = await authStore.mcpSession(request);
    if (!session) throw httpError(401, 'A MundusX user access token is required');
    if (profiles && request.method === 'GET') sendJson(response, 200, service.profiles());
    else if (match && !match[1] && request.method === 'POST') {
      const result = await service.submit(session.id, await readJsonBody(request));
      response.setHeader('Location', result.status_url);
      response.setHeader('Retry-After', '15');
      sendJson(response, 202, result);
    } else if (match?.[1] && !match[2] && request.method === 'GET') sendJson(response, 200, await service.status(session.id, match[1]));
    else if (match?.[2] && request.method === 'POST') sendJson(response, 200, await service.result(session.id, match[1]));
    else throw httpError(405, 'Method not allowed');
    return true;
  };
}
