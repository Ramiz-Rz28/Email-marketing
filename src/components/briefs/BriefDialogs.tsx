"use client";

import { useState } from "react";
import { Button, Modal, TextField, Label, TextArea, useOverlayState } from "@heroui/react";
import { Check, X } from "lucide-react";
import { approveBrief, rejectBrief } from "@/actions/briefs";
import { formatNumber } from "@/lib/format";
import { useActionRunner } from "./useActionRunner";

export function ApproveDialog({
  briefId,
  recipientCount,
  variant = "primary",
  size = "md",
}: {
  briefId: string;
  recipientCount: number | null;
  variant?: "primary" | "secondary";
  size?: "sm" | "md";
}) {
  const state = useOverlayState();
  const { pending, error, setError, run } = useActionRunner();

  return (
    <>
      <Button
        variant={variant}
        size={size}
        onPress={() => {
          setError(null);
          state.open();
        }}
      >
        <Check size={15} aria-hidden />
        Approve
      </Button>
      <Modal state={state}>
        <Modal.Backdrop>
          <Modal.Container size="sm" placement="center">
            <Modal.Dialog>
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>Approve this campaign?</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p className="text-sm text-muted">
                  {recipientCount !== null
                    ? `Up to ${formatNumber(recipientCount)} subscribed customers will be eligible to receive this email.`
                    : "Eligible subscribed customers will receive this email."}{" "}
                  Suppressions and the weekly frequency cap are re-checked at send time, so the final count can be lower.
                </p>
                {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onPress={state.close} isDisabled={pending}>
                  Cancel
                </Button>
                <Button isPending={pending} onPress={() => run(() => approveBrief(briefId), state.close)}>
                  Approve and schedule
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}

export function RejectDialog({ briefId }: { briefId: string }) {
  const state = useOverlayState();
  const [reason, setReason] = useState("");
  const { pending, error, setError, run } = useActionRunner();

  return (
    <>
      <Button
        variant="ghost"
        onPress={() => {
          setError(null);
          state.open();
        }}
      >
        <X size={15} aria-hidden />
        Reject
      </Button>
      <Modal state={state}>
        <Modal.Backdrop>
          <Modal.Container size="sm" placement="center">
            <Modal.Dialog>
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>Reject this brief</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <TextField fullWidth value={reason} onChange={setReason} name="reason">
                  <Label>Reason</Label>
                  <TextArea rows={3} placeholder="What should change? This feeds future planning." />
                </TextField>
                {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onPress={state.close} isDisabled={pending}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  isPending={pending}
                  isDisabled={reason.trim().length === 0}
                  onPress={() =>
                    run(() => rejectBrief(briefId, reason.trim()), () => {
                      setReason("");
                      state.close();
                    })
                  }
                >
                  Reject brief
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}
