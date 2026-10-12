import { parseJSON, stringifyJSON } from './resultJSON';
export class APIError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: unknown,
  ) {
    super(message);
  }
}
export const id = (value: string) => encodeURIComponent(value);
export const labPath = (labId: string) => `/labs/${id(labId)}`;
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    throw new Error('Αδυναμία σύνδεσης με τον διακομιστή.');
  }
  if (!response.ok) {
    let data: { code?: string; message?: string; details?: unknown } = {};
    try {
      data = parseJSON(await response.text()) as typeof data;
    } catch {
      /* non-JSON errors remain explicit */
    }
    if (response.status === 401 && path !== '/session')
      window.dispatchEvent(new Event('catalog:unauthorized'));
    throw new APIError(
      response.status,
      data.code || 'http_error',
      data.message || `Σφάλμα HTTP ${response.status}`,
      data.details,
    );
  }
  if (response.status === 204) return undefined as T;
  return parseJSON(await response.text()) as T;
}
export const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: stringifyJSON(body),
});
export const download = (fileId: string) => `/api/v1/files/${id(fileId)}/download`;
