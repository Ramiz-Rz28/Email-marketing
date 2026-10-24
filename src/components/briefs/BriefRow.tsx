"use client";

import Link from "next/link";
import { Chip } from "@heroui/react";
import { buttonVariants } from "@heroui/styles";
import { LIFECYCLE_LABELS, formatNumber } from "@/lib/format";
import { ApproveDialog } from "./BriefDialogs";

export type BriefRowData = {
  id: string;
  lifecycle_job: string;
  title: string;
  subject: string;
  audience_count: number | null;
};

/** One line in the "Awaiting your approval" list on the overview page. */
export function BriefRow({ brief }: { brief: BriefRowData }) {
  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{brief.title}</p>
          <Chip size="sm" variant="soft" color="accent">
            {LIFECYCLE_LABELS[brief.lifecycle_job] ?? brief.lifecycle_job}
          </Chip>
        </div>
        <p className="mt-1 truncate text-sm text-muted">
          {brief.subject}
          {brief.audience_count !== null ? ` · ${formatNumber(brief.audience_count)} recipients` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link href="/approvals" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          Review
        </Link>
        <ApproveDialog briefId={brief.id} recipientCount={brief.audience_count} variant="secondary" size="sm" />
      </div>
    </li>
  );
}
