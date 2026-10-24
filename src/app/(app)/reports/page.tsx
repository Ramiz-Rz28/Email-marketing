import Link from "next/link";
import { Table } from "@heroui/react";
import { BarChart3 } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { requireStore } from "@/lib/auth";
import { formatDate, formatMoney, formatNumber, formatPercent } from "@/lib/format";
import { reportsSummary } from "@/lib/queries/dashboard";

export default async function ReportsPage() {
  const { store } = await requireStore();
  const { campaigns, totals30d: t } = await reportsSummary(store.id);

  return (
    <>
      <PageHeader title="Reports" description="Performance by campaign, plus a 30-day roll-up." />

      <section aria-label="Last 30 days" className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Sent" value={formatNumber(t.sent)} hint="30 days" />
        <StatCard label="Delivered" value={formatPercent(t.delivered, t.sent)} hint={`${formatNumber(t.delivered)} emails`} />
        <StatCard label="Opened" value={formatPercent(t.opened, t.delivered)} hint={`${formatNumber(t.opened)} emails`} />
        <StatCard label="Clicked" value={formatPercent(t.clicked, t.delivered)} hint={`${formatNumber(t.clicked)} emails`} />
        <StatCard label="Revenue" value={formatMoney(t.revenue)} hint="attributed, 30 days" />
      </section>

      <h2 className="mb-3 mt-10 text-base font-semibold">By campaign</h2>
      {campaigns.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No campaign results yet"
          body="Results appear here once your first approved campaign has been sent."
        />
      ) : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label="Campaign performance" className="min-w-[900px]">
              <Table.Header>
                <Table.Column isRowHeader>Campaign</Table.Column>
                <Table.Column>Date</Table.Column>
                <Table.Column>Sent</Table.Column>
                <Table.Column>Delivered</Table.Column>
                <Table.Column>Opened</Table.Column>
                <Table.Column>Clicked</Table.Column>
                <Table.Column>Bounced</Table.Column>
                <Table.Column>Unsubscribed</Table.Column>
                <Table.Column>Revenue</Table.Column>
              </Table.Header>
              <Table.Body>
                {campaigns.map((c) => (
                  <Table.Row key={c.id} id={c.id}>
                    <Table.Cell>
                      <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                    </Table.Cell>
                    <Table.Cell className="text-muted">{formatDate(c.sent_on)}</Table.Cell>
                    <Table.Cell className="tabular-nums">{formatNumber(c.sent)}</Table.Cell>
                    <Table.Cell className="tabular-nums">{formatNumber(c.delivered)}</Table.Cell>
                    <Table.Cell className="tabular-nums">
                      {formatNumber(c.opened)} <span className="text-muted">({formatPercent(c.opened, c.delivered)})</span>
                    </Table.Cell>
                    <Table.Cell className="tabular-nums">
                      {formatNumber(c.clicked)} <span className="text-muted">({formatPercent(c.clicked, c.delivered)})</span>
                    </Table.Cell>
                    <Table.Cell className="tabular-nums">{formatNumber(c.bounced)}</Table.Cell>
                    <Table.Cell className="tabular-nums">{formatNumber(c.unsubscribed)}</Table.Cell>
                    <Table.Cell className="tabular-nums font-medium">{formatMoney(c.revenue)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}
    </>
  );
}
