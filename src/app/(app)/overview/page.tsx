import Link from "next/link";
import { Card } from "@heroui/react";
import { buttonVariants } from "@heroui/styles";
import { CheckCircle2, Plug } from "lucide-react";
import { BriefRow } from "@/components/briefs/BriefRow";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { requireStore } from "@/lib/auth";
import { formatDateTime, formatMoney, formatNumber, humanize } from "@/lib/format";
import { overviewStats, pendingBriefs, recentActivity, shopifyConnection } from "@/lib/queries/dashboard";

function pctChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

function actorLabel(actor: string): string {
  if (actor === "ai") return "AI";
  if (actor === "system") return "System";
  return "Team";
}

export default async function OverviewPage() {
  const { store } = await requireStore();
  const [stats, briefs, activity, connection] = await Promise.all([
    overviewStats(store.id),
    pendingBriefs(store.id, 5),
    recentActivity(store.id, 8),
    shopifyConnection(store.id),
  ]);

  return (
    <>
      <PageHeader
        title="Overview"
        description="What your lifecycle emails earned in the last 30 days, and what needs a decision."
      />

      {!connection ? (
        <div className="mb-8">
          <EmptyState
            icon={Plug}
            title="Connect your Shopify store"
            body="Customers, orders and products sync automatically once connected. Nothing is sent until you approve it."
            action={
              <Link href="/settings" className={buttonVariants({ variant: "primary" })}>
                Connect Shopify
              </Link>
            }
          />
        </div>
      ) : null}

      <section aria-label="Key numbers" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Attributed revenue"
          value={formatMoney(stats.revenue30d)}
          delta={pctChange(stats.revenue30d, stats.revenuePrev30d)}
          hint="last 30 days"
        />
        <StatCard
          label="Emails sent"
          value={formatNumber(stats.emailsSent30d)}
          delta={pctChange(stats.emailsSent30d, stats.emailsSentPrev30d)}
          hint="last 30 days"
        />
        <StatCard label="Subscribed customers" value={formatNumber(stats.subscribed)} hint="can receive marketing" />
        <StatCard label="Awaiting approval" value={formatNumber(stats.pendingBriefs)} hint="draft campaigns" />
      </section>

      <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <Card.Header className="flex-row items-center justify-between">
            <Card.Title>Awaiting your approval</Card.Title>
            {stats.pendingBriefs > briefs.length ? (
              <Link href="/approvals" className="text-sm text-muted hover:text-foreground">
                View all {stats.pendingBriefs}
              </Link>
            ) : null}
          </Card.Header>
          <Card.Content>
            {briefs.length === 0 ? (
              <div className="flex flex-col items-center py-8 text-center">
                <CheckCircle2 size={22} className="mb-2 text-success" aria-hidden />
                <p className="text-sm font-medium">You are all caught up</p>
                <p className="mt-1 text-sm text-muted">New AI-planned campaigns will show up here for review.</p>
              </div>
            ) : (
              <ul className="divide-y divide-separator">
                {briefs.map((b) => (
                  <BriefRow
                    key={b.id}
                    brief={{
                      id: b.id,
                      lifecycle_job: b.lifecycle_job,
                      title: b.title,
                      subject: b.subject,
                      audience_count: b.audience_count,
                    }}
                  />
                ))}
              </ul>
            )}
          </Card.Content>
        </Card>

        <Card className="lg:col-span-2">
          <Card.Header>
            <Card.Title>Recent activity</Card.Title>
          </Card.Header>
          <Card.Content>
            {activity.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">No activity yet.</p>
            ) : (
              <ul className="space-y-4">
                {activity.map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{humanize(a.action)}</p>
                      <p className="text-xs text-muted">{actorLabel(a.actor)}</p>
                    </div>
                    <time className="shrink-0 text-xs text-muted" dateTime={a.created_at.toISOString()}>
                      {formatDateTime(a.created_at)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </Card.Content>
        </Card>
      </div>
    </>
  );
}
