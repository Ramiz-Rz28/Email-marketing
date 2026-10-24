import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, Chip, Table } from "@heroui/react";
import { buttonVariants } from "@heroui/styles";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { requireStore } from "@/lib/auth";
import {
  CAMPAIGN_STATUS_COLOR,
  SEND_STATUS_COLOR,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  humanize,
  maskEmail,
} from "@/lib/format";
import { campaignDetail, campaignSends } from "@/lib/queries/dashboard";

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const [{ id }, { page }] = await Promise.all([params, searchParams]);
  const { store } = await requireStore();

  // Reject non-uuid ids before they reach the database.
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const detail = await campaignDetail(store.id, id);
  if (!detail) notFound();

  const sends = await campaignSends(store.id, id, Number(page) || 1);
  const { counts } = detail;
  const totalPages = Math.max(1, Math.ceil(sends.total / sends.pageSize));
  const from = sends.total === 0 ? 0 : (sends.page - 1) * sends.pageSize + 1;
  const to = Math.min(sends.total, sends.page * sends.pageSize);

  return (
    <>
      <Link href="/campaigns" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
        <ArrowLeft size={14} aria-hidden /> All campaigns
      </Link>
      <PageHeader
        title={detail.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Chip size="sm" variant="soft" color={CAMPAIGN_STATUS_COLOR[detail.status] ?? "default"}>
              {detail.status}
            </Chip>
            <span>{detail.subject}</span>
            <span aria-hidden>·</span>
            <span>{formatDateTime(detail.finished_at ?? detail.started_at ?? detail.scheduled_for)}</span>
          </span>
        }
      />

      <section aria-label="Funnel" className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Recipients" value={formatNumber(detail.recipients)} hint={`${formatNumber(counts.sent)} sent`} />
        <StatCard
          label="Delivered"
          value={formatPercent(counts.delivered, counts.sent)}
          hint={`${formatNumber(counts.delivered)} emails`}
        />
        <StatCard
          label="Opened"
          value={formatPercent(counts.opened, counts.delivered)}
          hint={`${formatNumber(counts.opened)} emails`}
        />
        <StatCard
          label="Clicked"
          value={formatPercent(counts.clicked, counts.delivered)}
          hint={`${formatNumber(counts.clicked)} emails`}
        />
        <StatCard label="Revenue" value={formatMoney(detail.revenue)} hint="last-click, 7 days" />
      </section>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <Card.Header>
            <Card.Title>Skipped at send time</Card.Title>
            <Card.Description>Guardrails remove these recipients automatically.</Card.Description>
          </Card.Header>
          <Card.Content>
            {detail.skipReasons.length === 0 ? (
              <p className="text-sm text-muted">No recipients were skipped.</p>
            ) : (
              <ul className="space-y-2.5 text-sm">
                {detail.skipReasons.map((r) => (
                  <li key={r.reason} className="flex items-center justify-between">
                    <span>{humanize(r.reason)}</span>
                    <span className="font-medium tabular-nums">{formatNumber(r.count)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-5 flex gap-6 border-t border-separator pt-4 text-sm">
              <div>
                <p className="text-xs text-muted">Bounced</p>
                <p className="font-medium tabular-nums">{formatNumber(counts.bounced)}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Complaints</p>
                <p className="font-medium tabular-nums">{formatNumber(counts.complained)}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Failed</p>
                <p className="font-medium tabular-nums">{formatNumber(counts.failed)}</p>
              </div>
            </div>
          </Card.Content>
        </Card>

        <div className="lg:col-span-2">
          <h2 className="mb-3 text-base font-semibold">Sends</h2>
          {sends.rows.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted">
              No sends recorded for this campaign yet.
            </p>
          ) : (
            <Table>
              <Table.ScrollContainer>
                <Table.Content aria-label="Sends" className="min-w-[620px]">
                  <Table.Header>
                    <Table.Column isRowHeader>Recipient</Table.Column>
                    <Table.Column>Status</Table.Column>
                    <Table.Column>Sent</Table.Column>
                    <Table.Column>Delivered</Table.Column>
                    <Table.Column>Clicked</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {sends.rows.map((s) => (
                      <Table.Row key={s.id} id={s.id}>
                        <Table.Cell className="font-mono text-xs">{maskEmail(s.email)}</Table.Cell>
                        <Table.Cell>
                          <Chip size="sm" variant="soft" color={SEND_STATUS_COLOR[s.status] ?? "default"}>
                            {s.status === "skipped" && s.skip_reason ? `skipped: ${humanize(s.skip_reason).toLowerCase()}` : s.status}
                          </Chip>
                        </Table.Cell>
                        <Table.Cell className="text-muted">{formatDateTime(s.sent_at)}</Table.Cell>
                        <Table.Cell className="text-muted">{formatDateTime(s.delivered_at)}</Table.Cell>
                        <Table.Cell className="text-muted">{formatDateTime(s.clicked_at)}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          )}

          {sends.total > sends.pageSize ? (
            <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm text-muted">
              <span>
                {from}–{to} of {formatNumber(sends.total)}
              </span>
              <div className="flex gap-2">
                {sends.page > 1 ? (
                  <Link
                    href={`/campaigns/${id}?page=${sends.page - 1}`}
                    className={buttonVariants({ variant: "secondary", size: "sm" })}
                  >
                    <ChevronLeft size={14} aria-hidden /> Previous
                  </Link>
                ) : null}
                {sends.page < totalPages ? (
                  <Link
                    href={`/campaigns/${id}?page=${sends.page + 1}`}
                    className={buttonVariants({ variant: "secondary", size: "sm" })}
                  >
                    Next <ChevronRight size={14} aria-hidden />
                  </Link>
                ) : null}
              </div>
            </nav>
          ) : null}
        </div>
      </div>
    </>
  );
}
