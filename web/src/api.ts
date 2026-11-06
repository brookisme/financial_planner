/**
 * @fileoverview Calls to the local server. Writes carry the X-Financial-Planner header the server
 * requires.
 *
 * License: BSD 3-Clause
 */

//
// CONSTANTS
//
const WRITE_HEADERS = {'Content-Type': 'application/json', 'X-Financial-Planner': '1'};

//
// PUBLIC
//

/** An error message from the server. */
export class ApiError extends Error {}

/** GET JSON. */
export async function get<T>(path: string): Promise<T> {
  return handle<T>(await fetch(path, {cache: 'no-store'}));
}

/** Send JSON with a method (PUT / POST). */
export async function send<T>(method: string, path: string, body: unknown): Promise<T> {
  return handle<T>(await fetch(path, {method, headers: WRITE_HEADERS,
    body: JSON.stringify(body ?? null)}));
}

/** Upload a file's raw bytes. */
export async function upload<T>(path: string, file: File): Promise<T> {
  return handle<T>(await fetch(path, {method: 'POST',
    headers: {'X-Financial-Planner': '1', 'Content-Type': 'text/csv'}, body: file}));
}

//
// INTERNAL
//

/** Parse a response, throwing ApiError with the server's message on failure. */
async function handle<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (body as {detail?: unknown; error?: unknown}).detail ??
        (body as {error?: unknown}).error ?? res.statusText;
    throw new ApiError(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return body as T;
}
