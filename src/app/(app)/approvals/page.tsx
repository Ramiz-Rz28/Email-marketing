import { Card, Chip, Tabs } from "@heroui/react";
import { Inbox, Percent, Users } from "lucide-react";
import { BriefActions } from "@/components/briefs/BriefActions";
import { BriefPreview } from "@/components/briefs/BriefPreview";
import { PlanNowButtons } from "@/components/briefs/PlanNowButtons";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireStore } from "@/lib/auth";
import { LIFECYCLE_LABELS, formatDate, formatDateTime, formatNumber } from "@/lib/format";
import { briefsByStatus, type BriefDetail } from "@/lib/queries/dashboard";

type OutlineBlock = { type: string; lines: string[] };

function clip(s: string, n = 220): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Blocks follow BlockSchema (src/lib/ai/brief-schema.ts); unknown shapes degrade to a generic dump. */
function toOutline(blocks: unknown): OutlineBlock[] {
  if (!Array.isArray(blocks)) return [];
  const out: OutlineBlock[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    switch (b.type) {
      case "heading":
        out.push({ type: "Heading", lines: [clip(str(b.text))] });
        break;
      case "paragraph":
        out.push({ type: "Paragraph", lines: [clip(str(b.text))] });
        break;
      case "products":
        out.push({
          type: "Products",
          lines: [`Up to ${Number(b.max) || 4} · ${str(b.source).replace(/_/g, " ")}`],
        });
        break;
      case "cta":
        out.push({ type: "Button", lines: [`${str(b.label)} → ${str(b.url_var)}`] });
        break;
      case "discount":
        out.push({ type: "Discount", lines: [clip(str(b.headline)), "Shown only when a code exists"] });
        break;
      case "spacer":
        break;
      default:
        out.push({ type: str(b.type) || "Block", lines: [] });
    }
  }
  return out;
}

function discountText(brief: BriefDetail): string | null {
  if (brief.discount_code) return `Code ${brief.discount_code}`;
  const d = brief.discount_suggestion;
  if (d && typeof d.percent === "number") return `${d.percent}% off${d.reason ? ` — ${d.reason}` : ""}`;
  return null;
}

const STATUS_CHIP: Record<string, "default" | "success" | "danger" | "warning" | "accent"> = {
  draft: "warning",
  approved: "success",
  sent: "success",
  rejected: "danger",
  expired: "default",
};

function BriefCard({ brief }: { brief: BriefDetail }) {
  const outline = toOutline(brief.blocks);
  const discount = discountText(brief);
  const isDraft = brief.status === "draft";

  return (
    <Card>
      <Card.Header className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm" variant="soft" color="accent">
            {LIFECYCLE_LABELS[brief.lifecycle_job] ?? brief.lifecycle_job}
          </Chip>
          <Chip size="sm" variant="soft" color={STATUS_CHIP[brief.status] ?? "default"}>
            {brief.status}
          </Chip>
          <span className="text-xs text-muted">Planned {formatDate(brief.created_at)}</span>
        </div>
        <Card.Title className="text-lg">{brief.title}</Card.Title>
        <Card.Description className="max-w-3xl text-sm leading-relaxed">{brief.rationale}</Card.Description>
      </Card.Header>

      <Card.Content className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <div className="space-y-6">
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Subject</dt>
              <dd className="mt-0.5 font-medium">{brief.subject}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Preheader</dt>
              <dd className="mt-0.5">{brief.preheader || "—"}</dd>
            </div>
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <div>
                <dt className="flex items-center gap-1 text-xs uppercase tracking-wide text-muted">
                  <Users size={12} aria-hidden /> Audience
                </dt>
                <dd className="mt-0.5 font-medium tabular-nums">
                  {brief.audience_count !== null ? `${formatNumber(brief.audience_count)} customers` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Send window</dt>
                <dd className="mt-0.5">
                  {brief.send_window_start
                    ? `${formatDateTime(brief.send_window_start)}${
                        brief.send_window_end ? ` – ${formatDateTime(brief.send_window_end)}` : ""
                      }`
                    : "As soon as approved"}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Template</dt>
                <dd className="mt-0.5">{brief.template_name ?? "—"}</dd>
              </div>
            </div>
            {discount ? (
              <div>
                <dt className="flex items-center gap-1 text-xs uppercase tracking-wide text-muted">
                  <Percent size={12} aria-hidden /> Discount suggestion
                </dt>
                <dd className="mt-0.5 font-medium">{discount}</dd>
              </div>
            ) : null}
          </dl>

          <div>
            <p className="mb-2 text-xs uppercase tracking-wide text-muted">Email outline</p>
            {outline.length === 0 ? (
              <p className="text-sm text-muted">No content blocks.</p>
            ) : (
              <ol className="space-y-2.5 border-l border-separator pl-4">
                {outline.map((b, i) => (
                  <li key={i} className="text-sm">
                    <span className="text-xs font-medium text-accent">{b.type}</span>
                    {b.lines.map((l, j) => (
                      <p key={j} className="text-foreground/90">
                        {l}
                      </p>
                    ))}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <BriefPreview html={brief.preview_html} title={brief.title} />
      </Card.Content>

      {isDraft ? (
        <Card.Footer>
          <BriefActions briefId={brief.id} recipientCount={brief.audience_count} />
        </Card.Footer>
      ) : brief.approved_at ? (
        <Card.Footer>
          <p className="text-xs text-muted">Approved {formatDateTime(brief.approved_at)}</p>
        </Card.Footer>
      ) : null}
    </Card>
  );
}

function BriefList({ briefs, empty }: { briefs: BriefDetail[]; empty: { title: string; body: string } }) {
  if (briefs.length === 0) return <EmptyState icon={Inbox} title={empty.title} body={empty.body} />;
  return (
    <div className="space-y-6">
      {briefs.map((b) => (
        <BriefCard key={b.id} brief={b} />
      ))}
    </div>
  );
}

export default async function ApprovalsPage() {
  const { store } = await requireStore();
  const [draft, approved, rejected] = await Promise.all([
    briefsByStatus(store.id, ["draft"]),
    briefsByStatus(store.id, ["approved", "sent"]),
    briefsByStatus(store.id, ["rejected"]),
  ]);

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Review what the AI planned. Nothing is sent to customers until you approve it."
        actions={<PlanNowButtons />}
      />

      <Tabs defaultSelectedKey="draft">
        <Tabs.ListContainer>
          <Tabs.List aria-label="Brief status">
            <Tabs.Tab id="draft">
              Draft ({draft.length})
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="approved">
              Approved ({approved.length})
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="rejected">
              Rejected ({rejected.length})
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="draft" className="pt-6">
          <BriefList
            briefs={draft}
            empty={{
              title: "Nothing to approve",
              body: "Use the Plan buttons above to ask the AI for a new campaign, or wait for the next scheduled run.",
            }}
          />
        </Tabs.Panel>
        <Tabs.Panel id="approved" className="pt-6">
          <BriefList
            briefs={approved}
            empty={{ title: "No approved campaigns yet", body: "Approved briefs are scheduled and tracked here." }}
          />
        </Tabs.Panel>
        <Tabs.Panel id="rejected" className="pt-6">
          <BriefList
            briefs={rejected}
            empty={{ title: "No rejected briefs", body: "Briefs you reject are kept here for reference." }}
          />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
