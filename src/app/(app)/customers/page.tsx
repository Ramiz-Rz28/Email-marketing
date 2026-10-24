import Link from "next/link";
import { Button, Chip, Input, ProgressBar, Table } from "@heroui/react";
import { buttonVariants } from "@heroui/styles";
import { ChevronLeft, ChevronRight, Search, Users } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireStore } from "@/lib/auth";
import {
  MARKETING_STATE_COLOR,
  formatDate,
  formatMoney,
  formatNumber,
  humanize,
  maskEmail,
} from "@/lib/format";
import { customersList } from "@/lib/queries/dashboard";

/** Scores may be stored 0–1 or 0–100; normalise to 0–100. */
function toPercent(score: number | null): number | null {
  if (score === null || !Number.isFinite(score)) return null;
  const pct = score <= 1 ? score * 100 : score;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function riskColor(pct: number): "success" | "warning" | "danger" {
  if (pct >= 67) return "danger";
  if (pct >= 34) return "warning";
  return "success";
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { q, page } = await searchParams;
  const { store } = await requireStore();
  const query = (q ?? "").slice(0, 100);
  const result = await customersList(store.id, { q: query, page: Number(page) || 1 });

  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const href = (p: number) => `/customers?${new URLSearchParams({ ...(query ? { q: query } : {}), page: String(p) })}`;

  return (
    <>
      <PageHeader
        title="Customers"
        description={`${formatNumber(result.total)} ${result.total === 1 ? "customer" : "customers"}${
          query ? ` matching "${query}"` : ""
        }. Only subscribed customers can receive marketing.`}
      />

      <form method="get" action="/customers" role="search" className="mb-6 flex max-w-md gap-2">
        <label className="sr-only" htmlFor="customer-search">
          Search customers
        </label>
        <Input
          id="customer-search"
          name="q"
          type="search"
          fullWidth
          defaultValue={query}
          placeholder="Search by name or email"
        />
        <Button type="submit" variant="secondary">
          <Search size={15} aria-hidden />
          Search
        </Button>
      </form>

      {result.rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title={query ? "No customers match your search" : "No customers yet"}
          body={
            query
              ? "Try a different name or email."
              : "Customers appear here after your Shopify store is connected and synced."
          }
          action={
            query ? (
              <Link href="/customers" className={buttonVariants({ variant: "secondary" })}>
                Clear search
              </Link>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label="Customers" className="min-w-[940px]">
              <Table.Header>
                <Table.Column isRowHeader>Customer</Table.Column>
                <Table.Column>Email</Table.Column>
                <Table.Column>Marketing</Table.Column>
                <Table.Column>Orders</Table.Column>
                <Table.Column>Spent</Table.Column>
                <Table.Column>Last order</Table.Column>
                <Table.Column>Segment</Table.Column>
                <Table.Column>Churn risk</Table.Column>
              </Table.Header>
              <Table.Body>
                {result.rows.map((c) => {
                  const risk = toPercent(c.churn_risk);
                  const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
                  return (
                    <Table.Row key={c.id} id={c.id}>
                      <Table.Cell className="font-medium">{name || "—"}</Table.Cell>
                      <Table.Cell className="font-mono text-xs">{maskEmail(c.email)}</Table.Cell>
                      <Table.Cell>
                        <Chip size="sm" variant="soft" color={MARKETING_STATE_COLOR[c.marketing_state] ?? "default"}>
                          {humanize(c.marketing_state)}
                        </Chip>
                      </Table.Cell>
                      <Table.Cell className="tabular-nums">{formatNumber(c.orders_count)}</Table.Cell>
                      <Table.Cell className="tabular-nums">{formatMoney(c.total_spent)}</Table.Cell>
                      <Table.Cell className="text-muted">{formatDate(c.last_order_at)}</Table.Cell>
                      <Table.Cell>{c.rfm_segment ? humanize(c.rfm_segment) : <span className="text-muted">—</span>}</Table.Cell>
                      <Table.Cell>
                        {risk === null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <ProgressBar aria-label={`Churn risk ${risk}%`} value={risk} color={riskColor(risk)} size="sm" className="w-24">
                            <ProgressBar.Track>
                              <ProgressBar.Fill />
                            </ProgressBar.Track>
                          </ProgressBar>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}

      {result.total > result.pageSize ? (
        <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm text-muted">
          <span>
            Page {result.page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {result.page > 1 ? (
              <Link href={href(result.page - 1)} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                <ChevronLeft size={14} aria-hidden /> Previous
              </Link>
            ) : null}
            {result.page < totalPages ? (
              <Link href={href(result.page + 1)} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                Next <ChevronRight size={14} aria-hidden />
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </>
  );
}
