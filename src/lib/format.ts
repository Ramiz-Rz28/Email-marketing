/** Display helpers shared by the merchant dashboard. Pure functions, safe on server and client. */

export function maskEmail(email: string | null | undefined): string {
  if (!email) return "—";
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export function formatMoney(value: number | string | null | undefined, currency = "CAD"): string {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    maximumFractionDigits: n >= 1000 ? 0 : 2,
  }).format(Number.isFinite(n) ? n : 0);
}

export function formatNumber(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat("en-CA").format(Number.isFinite(n) ? n : 0);
}

export function formatPercent(numerator: number, denominator: number): string {
  if (!denominator) return "—";
  const p = (numerator / denominator) * 100;
  return `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" }).format(d);
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(d);
}

export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const s = value.replace(/[._]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const LIFECYCLE_JOBS = ["cart_recovery", "second_purchase", "winback", "affinity"] as const;
export type LifecycleJob = (typeof LIFECYCLE_JOBS)[number];

export const LIFECYCLE_LABELS: Record<string, string> = {
  cart_recovery: "Cart recovery",
  second_purchase: "Second purchase",
  winback: "Win-back",
  affinity: "Product affinity",
  manual: "Manual",
};

export type ChipColor = "default" | "accent" | "success" | "warning" | "danger";

export const CAMPAIGN_STATUS_COLOR: Record<string, ChipColor> = {
  queued: "default",
  sending: "accent",
  sent: "success",
  failed: "danger",
  cancelled: "default",
};

export const SEND_STATUS_COLOR: Record<string, ChipColor> = {
  queued: "default",
  skipped: "warning",
  sent: "accent",
  delivered: "success",
  bounced: "danger",
  complained: "danger",
  failed: "danger",
};

export const MARKETING_STATE_COLOR: Record<string, ChipColor> = {
  subscribed: "success",
  pending: "warning",
  not_subscribed: "default",
  unsubscribed: "danger",
  invalid: "danger",
};
