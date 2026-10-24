"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Sparkles } from "lucide-react";
import { planNow } from "@/actions/briefs";
import { LIFECYCLE_JOBS, LIFECYCLE_LABELS, type LifecycleJob } from "@/lib/format";
import { useActionRunner } from "./useActionRunner";

/** Header buttons that enqueue an AI planning run for one lifecycle job. */
export function PlanNowButtons() {
  const { pending, error, run } = useActionRunner();
  const [active, setActive] = useState<LifecycleJob | null>(null);
  const [queued, setQueued] = useState<LifecycleJob | null>(null);

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap justify-end gap-2">
        {LIFECYCLE_JOBS.map((job) => (
          <Button
            key={job}
            size="sm"
            variant="secondary"
            isPending={pending && active === job}
            isDisabled={pending && active !== job}
            onPress={() => {
              setActive(job);
              setQueued(null);
              run(() => planNow(job), () => setQueued(job));
            }}
          >
            <Sparkles size={14} aria-hidden />
            Plan {LIFECYCLE_LABELS[job].toLowerCase()}
          </Button>
        ))}
      </div>
      {queued ? (
        <p className="text-xs text-muted">
          Planning {LIFECYCLE_LABELS[queued].toLowerCase()}. New drafts appear here in a minute or two.
        </p>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
