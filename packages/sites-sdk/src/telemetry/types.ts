export type BreadcrumbCategory =
  | "console"
  | "exception"
  | "fetch"
  | "xhr"
  | "ui.click"
  | "navigation"
  | "custom";

export type BreadcrumbLevel = "debug" | "info" | "warning" | "error";

export interface Breadcrumb {
  ts: number;
  category: BreadcrumbCategory;
  level: BreadcrumbLevel;
  message?: string;
  data?: Record<string, unknown>;
  url?: string;
}

export interface InitTelemetryOptions {
  /** Optional human-readable release identifier, e.g. a git sha. Surfaced in
   * the Breadcrumbs UI alongside the build pill. */
  release?: string;
  /** Drop a fraction of sessions before any capture happens. 1 = capture all,
   * 0 = capture none. Default 1. */
  sampleRate?: number;
  captureConsole?: boolean;
  captureNetwork?: boolean;
  captureClicks?: boolean;
  captureNavigation?: boolean;
  captureErrors?: boolean;
  /** Final hook before a breadcrumb is queued. Return null to drop. */
  beforeSend?: (crumb: Breadcrumb) => Breadcrumb | null;
  /** Maximum breadcrumbs held in memory before a flush is forced. Default 50. */
  flushAt?: number;
  /** Background flush interval (ms). Default 5000. */
  flushIntervalMs?: number;
}

export interface TelemetryHandle {
  /** Push a custom breadcrumb. No-op if telemetry didn't initialise. */
  log(crumb: Omit<Breadcrumb, "ts">): void;
  /** Force an immediate flush. */
  flush(): Promise<void>;
  /** Stop instrumentation. Mostly useful for tests. */
  stop(): void;
  sessionId: string;
}
