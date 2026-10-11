/** Small helpers for reading untyped JSON without type assertions. */

export const DAY_MS = 86_400_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Keeps only string values, e.g. for `dependencies` maps. */
export function asStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

export function asStringArray(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === "string");
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.trim() ?? message;
}

export function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

const RETRY_STATUS = (status: number) => status === 429 || status >= 500;
const MAX_RETRY_WAIT_MS = 30_000;

/** Milliseconds to wait from a Retry-After header (seconds or HTTP date), else null. */
function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * fetch that retries 429 and 5xx responses with exponential backoff (1s, 2s, 4s...), honoring
 * Retry-After up to 30s. Returns the last response; each attempt gets its own 30s timeout.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  attempts = 4,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    if (!RETRY_STATUS(response.status) || attempt >= attempts) return response;
    const wait = retryAfterMs(response.headers.get("retry-after")) ?? 1000 * 2 ** (attempt - 1);
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, MAX_RETRY_WAIT_MS)));
  }
}

/** GET JSON with retries; null on 404. */
export async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetchWithRetry(url, init);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}
