import { sendBatch } from "./transport";
import type {
  Breadcrumb,
  BreadcrumbLevel,
  InitTelemetryOptions,
  TelemetryHandle,
} from "./types";

const DEFAULT_FLUSH_AT = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const MAX_STRING_LENGTH = 1024;
const SESSION_STORAGE_SESSION_KEY = "continual.telemetry.sessionId";
const SESSION_STORAGE_START_KEY = "continual.telemetry.startedAt";

let active: TelemetryHandle | null = null;

/**
 * Bootstrap browser telemetry for the current page. Idempotent — calling
 * twice returns the existing handle so site code can mount this in multiple
 * spots (layout + island) without duplicate instrumentation.
 *
 * Safe to call in non-browser contexts (returns a no-op handle).
 */
export function initTelemetry(
  options: InitTelemetryOptions = {}
): TelemetryHandle {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return noopHandle();
  }
  if (active) return active;

  const sampleRate = options.sampleRate ?? 1;
  if (Math.random() > sampleRate) {
    return noopHandle();
  }

  const sessionId = resolveSessionId();
  const startedAt = resolveStartedAt();
  const release = options.release ?? readReleaseFromMeta();
  const flushAt = options.flushAt ?? DEFAULT_FLUSH_AT;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

  const buffer: Breadcrumb[] = [];
  const teardown: Array<() => void> = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function record(crumb: Breadcrumb): void {
    if (stopped) return;
    const hooked = options.beforeSend ? options.beforeSend(crumb) : crumb;
    if (!hooked) return;
    buffer.push(truncateCrumb(hooked));
    if (buffer.length >= flushAt) {
      void flush();
    }
  }

  async function flush(useBeacon = false): Promise<void> {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    await sendBatch(
      {
        sessionId,
        startedAt,
        release,
        userAgent: navigator.userAgent,
        pageUrl: window.location.href,
        items: batch,
      },
      { useBeacon }
    );
  }

  // ─── Instrumenters ──────────────────────────────────────────────────────

  if (options.captureConsole !== false) {
    teardown.push(instrumentConsole(record));
  }
  if (options.captureErrors !== false) {
    teardown.push(instrumentErrors(record));
  }
  if (options.captureNetwork !== false) {
    teardown.push(instrumentFetch(record));
    teardown.push(instrumentXhr(record));
  }
  if (options.captureClicks !== false) {
    teardown.push(instrumentClicks(record));
  }
  if (options.captureNavigation !== false) {
    teardown.push(instrumentNavigation(record));
  }

  // First navigation breadcrumb so every session has an entry even if nothing
  // else fires.
  record({
    ts: Date.now(),
    category: "navigation",
    level: "info",
    message: window.location.pathname,
    url: window.location.href,
  });

  timer = setInterval(() => {
    void flush();
  }, flushIntervalMs);

  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      void flush(true);
    }
  };
  const onPagehide = () => {
    void flush(true);
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPagehide);
  teardown.push(() => document.removeEventListener("visibilitychange", onVisibility));
  teardown.push(() => window.removeEventListener("pagehide", onPagehide));

  const handle: TelemetryHandle = {
    sessionId,
    log(crumb) {
      record({ ts: Date.now(), ...crumb });
    },
    flush: () => flush(),
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      for (const fn of teardown) {
        try {
          fn();
        } catch {
          // ignore
        }
      }
      active = null;
    },
  };
  active = handle;
  return handle;
}

export function getTelemetry(): TelemetryHandle | null {
  return active;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function noopHandle(): TelemetryHandle {
  return {
    sessionId: "noop",
    log() {},
    async flush() {},
    stop() {},
  };
}

function resolveSessionId(): string {
  try {
    const existing = window.sessionStorage.getItem(SESSION_STORAGE_SESSION_KEY);
    if (existing) return existing;
  } catch {
    /* ignore */
  }
  const id = `ses_${cryptoRandom()}`;
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_SESSION_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}

function resolveStartedAt(): number {
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_START_KEY);
    if (raw) {
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
  } catch {
    /* ignore */
  }
  const now = Date.now();
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_START_KEY, String(now));
  } catch {
    /* ignore */
  }
  return now;
}

function cryptoRandom(): string {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const arr = new Uint8Array(12);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function readReleaseFromMeta(): string | undefined {
  const el = document.querySelector('meta[name="continual:release"]');
  return el?.getAttribute("content") ?? undefined;
}

function truncateCrumb(crumb: Breadcrumb): Breadcrumb {
  const next: Breadcrumb = {
    ts: crumb.ts,
    category: crumb.category,
    level: crumb.level,
  };
  if (crumb.message) next.message = truncate(crumb.message);
  if (crumb.url) next.url = truncate(crumb.url);
  if (crumb.data) next.data = truncateData(crumb.data);
  return next;
}

function truncate(value: string, max = MAX_STRING_LENGTH): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

function truncateData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string") out[k] = truncate(v);
    else out[k] = v;
  }
  return out;
}

// ─── Instrumenters ─────────────────────────────────────────────────────────

function instrumentConsole(record: (c: Breadcrumb) => void): () => void {
  const targets: Array<{
    method: "log" | "info" | "warn" | "error" | "debug";
    level: BreadcrumbLevel;
  }> = [
    { method: "log", level: "info" },
    { method: "info", level: "info" },
    { method: "warn", level: "warning" },
    { method: "error", level: "error" },
    { method: "debug", level: "debug" },
  ];
  const originals = new Map<string, (...args: unknown[]) => void>();
  for (const { method, level } of targets) {
    const original = (console as unknown as Record<string, (...args: unknown[]) => void>)[
      method
    ];
    if (typeof original !== "function") continue;
    originals.set(method, original);
    (console as unknown as Record<string, (...args: unknown[]) => void>)[method] = (
      ...args: unknown[]
    ) => {
      try {
        record({
          ts: Date.now(),
          category: "console",
          level,
          message: stringifyArgs(args),
        });
      } catch {
        /* ignore */
      }
      return original.apply(console, args);
    };
  }
  return () => {
    for (const [method, original] of originals.entries()) {
      (console as unknown as Record<string, (...args: unknown[]) => void>)[method] = original;
    }
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

function instrumentErrors(record: (c: Breadcrumb) => void): () => void {
  const onError = (event: ErrorEvent) => {
    record({
      ts: Date.now(),
      category: "exception",
      level: "error",
      message: event.message,
      data: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error instanceof Error ? event.error.stack : undefined,
      },
      url: window.location.href,
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : typeof reason === "string"
          ? reason
          : "Unhandled promise rejection";
    record({
      ts: Date.now(),
      category: "exception",
      level: "error",
      message,
      data: {
        kind: "unhandledrejection",
        stack: reason instanceof Error ? reason.stack : undefined,
      },
      url: window.location.href,
    });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

function instrumentFetch(record: (c: Breadcrumb) => void): () => void {
  if (typeof window.fetch !== "function") return () => {};
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const start = Date.now();
    const url = requestUrl(input);
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET") ?? "GET").toUpperCase();
    // Skip our own ingest traffic to avoid recursion.
    if (isSelfIngest(url)) return original(input, init);
    try {
      const response = await original(input, init);
      record({
        ts: start,
        category: "fetch",
        level: response.ok ? "info" : "warning",
        message: `${method} ${url} ${response.status}`,
        data: {
          method,
          url,
          status: response.status,
          durationMs: Date.now() - start,
        },
        url: window.location.href,
      });
      return response;
    } catch (error) {
      record({
        ts: start,
        category: "fetch",
        level: "error",
        message: `${method} ${url} (network error)`,
        data: {
          method,
          url,
          durationMs: Date.now() - start,
          error: error instanceof Error ? error.message : String(error),
        },
        url: window.location.href,
      });
      throw error;
    }
  };
  return () => {
    window.fetch = original;
  };
}

function instrumentXhr(record: (c: Breadcrumb) => void): () => void {
  if (typeof window.XMLHttpRequest === "undefined") return () => {};
  const Proto = window.XMLHttpRequest.prototype;
  const origOpen = Proto.open;
  const origSend = Proto.send;
  Proto.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    user?: string | null,
    password?: string | null
  ) {
    (this as unknown as { __continualXhr?: { method: string; url: string; startedAt: number } }).__continualXhr = {
      method: method.toUpperCase(),
      url: String(url),
      startedAt: 0,
    };
    return origOpen.call(this, method, url, async ?? true, user, password);
  } as typeof origOpen;
  Proto.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = (this as unknown as { __continualXhr?: { method: string; url: string; startedAt: number } }).__continualXhr;
    if (meta) {
      meta.startedAt = Date.now();
      if (isSelfIngest(meta.url)) {
        return origSend.call(this, body as Document | XMLHttpRequestBodyInit | null);
      }
      const onLoadEnd = () => {
        this.removeEventListener("loadend", onLoadEnd);
        record({
          ts: meta.startedAt,
          category: "xhr",
          level: this.status >= 400 ? "warning" : "info",
          message: `${meta.method} ${meta.url} ${this.status}`,
          data: {
            method: meta.method,
            url: meta.url,
            status: this.status,
            durationMs: Date.now() - meta.startedAt,
          },
          url: window.location.href,
        });
      };
      this.addEventListener("loadend", onLoadEnd);
    }
    return origSend.call(this, body as Document | XMLHttpRequestBodyInit | null);
  } as typeof origSend;
  return () => {
    Proto.open = origOpen;
    Proto.send = origSend;
  };
}

function instrumentClicks(record: (c: Breadcrumb) => void): () => void {
  const listener = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    record({
      ts: Date.now(),
      category: "ui.click",
      level: "info",
      message: describeTarget(target),
      data: {
        tag: target.tagName.toLowerCase(),
        id: target.id || undefined,
        // textContent intentionally omitted from inputs — avoid PII leak.
      },
      url: window.location.href,
    });
  };
  window.addEventListener("click", listener, { capture: true, passive: true });
  return () => window.removeEventListener("click", listener, { capture: true });
}

function describeTarget(el: Element): string {
  const parts: string[] = [el.tagName.toLowerCase()];
  if (el.id) parts.push(`#${el.id}`);
  const className =
    typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean).slice(0, 2) : [];
  for (const c of className) parts.push(`.${c}`);
  return parts.join("").slice(0, 200);
}

function instrumentNavigation(record: (c: Breadcrumb) => void): () => void {
  const fire = (from: string, to: string) => {
    record({
      ts: Date.now(),
      category: "navigation",
      level: "info",
      message: `${from} → ${to}`,
      data: { from, to },
      url: to,
    });
  };

  const origPush = history.pushState;
  const origReplace = history.replaceState;
  let lastUrl = window.location.href;

  history.pushState = function patchedPush(this: History, ...args: Parameters<typeof history.pushState>) {
    const prev = lastUrl;
    const result = origPush.apply(this, args);
    const next = window.location.href;
    if (next !== prev) {
      lastUrl = next;
      fire(prev, next);
    }
    return result;
  };
  history.replaceState = function patchedReplace(
    this: History,
    ...args: Parameters<typeof history.replaceState>
  ) {
    const prev = lastUrl;
    const result = origReplace.apply(this, args);
    const next = window.location.href;
    if (next !== prev) {
      lastUrl = next;
      fire(prev, next);
    }
    return result;
  };
  const onPop = () => {
    const next = window.location.href;
    if (next !== lastUrl) {
      const prev = lastUrl;
      lastUrl = next;
      fire(prev, next);
    }
  };
  window.addEventListener("popstate", onPop);

  return () => {
    history.pushState = origPush;
    history.replaceState = origReplace;
    window.removeEventListener("popstate", onPop);
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isSelfIngest(url: string): boolean {
  return (
    url.includes("/__continual/api/breadcrumbs") ||
    url.includes("/__continual/api/token") ||
    url.includes("/api/sites/runtime/preview/breadcrumbs") ||
    url.includes("/api/sites/runtime/breadcrumbs")
  );
}

// Re-export the types alongside the entry point for ergonomic imports.
export type { Breadcrumb, BreadcrumbCategory, BreadcrumbLevel } from "./types";
