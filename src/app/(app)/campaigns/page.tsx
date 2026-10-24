import Link from "next/link";
import { Chip, Table } from "@heroui/react";
import { Mail } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireStore } from "@/lib/auth";
import {
  CAMPAIGN_STATUS_COLOR,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { campaignsList } from "@/lib/queries/dashboard";

export default async function CampaignsPage() {
  const { store } = await requireStore();
  const campaigns = await campaignsList(store.id);

  return (
    <>
      <PageHeader title="Campaigns" description="Every approved campaign, with delivery and revenue results." />

      {campaigns.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="No campaigns yet"
          body="Approved briefs become campaigns. Review drafts on the Approvals page to get started."
        />
      ) : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label="Campaigns" className="min-w-[860px]">
              <Table.Header>
                <Table.Column isRowHeader>Campaign</Table.Column>
                <Table.Column>Status</Table.Column>
                <Table.Column>Scheduled / finished</Table.Column>
                <Table.Column>Recipients</Table.Column>
                <Table.Column>Delivered</Table.Column>
                <Table.Column>Clicked</Table.Column>
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
                    <Table.Cell>
                      <Chip
                        size="sm"
                        variant="soft"
                        color={CAMPAIGN_STATUS_COLOR[c.status] ?? "default"}
                      >
                        {c.status}
                      </Chip>
                    </Table.Cell>
                    <Table.Cell className="text-muted">{formatDateTime(c.finished_at ?? c.scheduled_for)}</Table.Cell>
                    <Table.Cell className="tabular-nums">{formatNumber(c.recipients)}</Table.Cell>
                    <Table.Cell className="tabular-nums">{formatPercent(c.delivered, c.sent)}</Table.Cell>
                    <Table.Cell className="tabular-nums">{formatPercent(c.clicked, c.delivered)}</Table.Cell>
                    <Table.Cell className="tabular-nums">{formatMoney(c.revenue)}</Table.Cell>
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
