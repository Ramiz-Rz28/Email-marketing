import { Card } from "@heroui/react";
import { TrendingDown, TrendingUp } from "lucide-react";

export function StatCard({
  label,
  value,
  delta,
  hint,
}: {
  label: string;
  value: string;
  /** Percent change vs previous period; null/undefined hides the badge. */
  delta?: number | null;
  hint?: string;
}) {
  const up = (delta ?? 0) >= 0;
  return (
    <Card>
      <Card.Content className="gap-1.5 p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
        <p className="text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
        <div className="flex min-h-5 items-center gap-2 text-xs text-muted">
          {delta !== null && delta !== undefined && Number.isFinite(delta) ? (
            <span className={`inline-flex items-center gap-1 font-medium ${up ? "text-success" : "text-danger"}`}>
              {up ? <TrendingUp size={13} aria-hidden /> : <TrendingDown size={13} aria-hidden />}
              {up ? "+" : ""}
              {delta.toFixed(0)}%
            </span>
          ) : null}
          {hint ? <span>{hint}</span> : null}
        </div>
      </Card.Content>
    </Card>
  );
}
