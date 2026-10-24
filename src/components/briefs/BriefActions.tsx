"use client";

import { Button } from "@heroui/react";
import { RefreshCw } from "lucide-react";
import { regenerateBrief } from "@/actions/briefs";
import { ApproveDialog, RejectDialog } from "./BriefDialogs";
import { useActionRunner } from "./useActionRunner";

/** Action bar for a draft brief card: Approve (primary), Reject, Regenerate. */
export function BriefActions({ briefId, recipientCount }: { briefId: string; recipientCount: number | null }) {
  const { pending, error, run } = useActionRunner();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ApproveDialog briefId={briefId} recipientCount={recipientCount} />
      <RejectDialog briefId={briefId} />
      <Button variant="secondary" isPending={pending} onPress={() => run(() => regenerateBrief(briefId))}>
        <RefreshCw size={15} aria-hidden />
        Regenerate
      </Button>
      {error ? <p className="w-full text-sm text-danger">{error}</p> : null}
    </div>
  );
}
