"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

function extractError(res: unknown): string | null {
  if (res && typeof res === "object") {
    const r = res as { ok?: unknown; error?: unknown };
    if (typeof r.error === "string" && r.error) return r.error;
    if (r.ok === false) return "The action could not be completed.";
  }
  return null;
}

/**
 * Runs a server action inside a transition, surfaces thrown/returned errors,
 * and refreshes the current route on success.
 */
export function useActionRunner() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<unknown>, onSuccess?: () => void) {
    setError(null);
    start(async () => {
      try {
        const res = await fn();
        const err = extractError(res);
        if (err) {
          setError(err);
          return;
        }
        onSuccess?.();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      }
    });
  }

  return { pending, error, setError, run };
}
