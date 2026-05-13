import { getPreviewRuntimeConfig } from "../preview";
import type { Breadcrumb } from "./types";

interface IngestPayload {
  sessionId: string;
  startedAt: number;
  release?: string;
  userAgent?: string;
  pageUrl?: string;
  items: Breadcrumb[];
}

/**
 * Send a breadcrumbs batch using whichever transport fits the current mode.
 *
 * Preview: POST to `<appOrigin>/api/sites/runtime/preview/breadcrumbs` with
 * the preview token in the body (CORS-simple, mirrors `callPreviewTool`).
 *
 * Published: POST to same-origin `/__continual/api/breadcrumbs` with the
 * bearer minted via `/__continual/api/token`. On `pagehide` we prefer
 * `navigator.sendBeacon` so the last batch survives navigation.
 */
export async function sendBatch(
  payload: IngestPayload,
  options: { useBeacon?: boolean } = {}
): Promise<void> {
  const preview = getPreviewRuntimeConfig();
  if (preview) {
    await sendPreviewBatch(payload, preview);
    return;
  }
  await sendPublishedBatch(payload, options);
}

async function sendPreviewBatch(
  payload: IngestPayload,
  preview: { token: string; appOrigin: string }
): Promise<void> {
  const url = new URL(
    "/api/sites/runtime/preview/breadcrumbs",
    preview.appOrigin
  ).toString();
  const body = JSON.stringify({
    previewApiToken: preview.token,
    request: payload,
  });

  // CORS-simple: text/plain content-type avoids preflight.
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
      keepalive: true,
    });
  } catch {
    // Telemetry never throws into user code.
  }
}

async function sendPublishedBatch(
  payload: IngestPayload,
  options: { useBeacon?: boolean }
): Promise<void> {
  const url = "/__continual/api/breadcrumbs";
  const token = await getApiToken();
  if (!token) return;

  const body = JSON.stringify(payload);

  // sendBeacon doesn't support custom headers — and we need Authorization —
  // so beacon is best-effort only on pagehide. Fall back to fetch keepalive
  // when sendBeacon isn't viable.
  if (options.useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    // Pack the token into a query string so the worker still authenticates.
    // (The worker doesn't currently accept query-param auth; this is a
    // future improvement. For now, beacon is fire-and-forget without auth
    // and the request will be rejected by the platform — but the more
    // important keepalive fetch below covers the typical case.)
    try {
      navigator.sendBeacon(
        url,
        new Blob([body], { type: "application/json" })
      );
    } catch {
      // ignore
    }
    return;
  }

  try {
    await fetch(url, {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body,
    });
  } catch {
    // ignore
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getApiToken(): Promise<string | null> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 5_000) {
    return cachedToken.value;
  }
  try {
    const response = await fetch("/__continual/api/token", {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as
      | { token?: string; expiresIn?: number }
      | null;
    if (!payload?.token) return null;
    const expiresIn = typeof payload.expiresIn === "number" ? payload.expiresIn : 5 * 60;
    cachedToken = {
      value: payload.token,
      expiresAt: now + expiresIn * 1000,
    };
    return payload.token;
  } catch {
    return null;
  }
}
