import { getCorrelationId } from './utils';

/**
 * Build CORS headers for a response.
 * @param request - The incoming request (used for Origin and Correlation-ID)
 * @returns Record of CORS header names to values
 */
export function buildCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '*';
  const correlationId = getCorrelationId(request);
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Google-API-Key, X-Correlation-ID, X-Request-ID',
    'Access-Control-Max-Age': '86400',
    'X-Correlation-ID': correlationId,
  };
}

/**
 * Return a preflight Response for an OPTIONS request.
 */
export function handleCorsPreflight(request: Request): Response {
  return new Response(null, {
    status: 200,
    headers: buildCorsHeaders(request),
  });
}
