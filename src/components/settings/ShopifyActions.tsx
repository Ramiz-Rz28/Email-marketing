"use client";

import { Button, Modal, useOverlayState } from "@heroui/react";
import { RefreshCw, Unplug } from "lucide-react";
import { disconnectShopify, triggerBackfill } from "@/actions/shopify";
import { useActionRunner } from "@/components/briefs/useActionRunner";

/** Re-sync + Disconnect (with confirmation) for an active Shopify connection. */
export function ShopifyActions() {
  const sync = useActionRunner();
  const disconnect = useActionRunner();
  const state = useOverlayState();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" isPending={sync.pending} onPress={() => sync.run(() => triggerBackfill())}>
        <RefreshCw size={15} aria-hidden />
        Re-sync
      </Button>
      <Button
        variant="ghost"
        onPress={() => {
          disconnect.setError(null);
          state.open();
        }}
      >
        <Unplug size={15} aria-hidden />
        Disconnect
      </Button>
      {sync.error ? <p className="w-full text-sm text-danger">{sync.error}</p> : null}

      <Modal state={state}>
        <Modal.Backdrop>
          <Modal.Container size="sm" placement="center">
            <Modal.Dialog>
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>Disconnect Shopify?</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p className="text-sm text-muted">
                  Syncing and webhooks stop and the access token is removed. Customers and orders already imported are
                  kept. You can reconnect at any time.
                </p>
                {disconnect.error ? <p className="mt-3 text-sm text-danger">{disconnect.error}</p> : null}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onPress={state.close} isDisabled={disconnect.pending}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  isPending={disconnect.pending}
                  onPress={() => disconnect.run(() => disconnectShopify(), state.close)}
                >
                  Disconnect
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}
