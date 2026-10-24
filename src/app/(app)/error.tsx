"use client";

import { useEffect } from "react";
import { Button } from "@heroui/react";
import { TriangleAlert } from "lucide-react";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-border px-6 py-16 text-center">
      <span className="mb-4 flex size-11 items-center justify-center rounded-full bg-danger-soft text-danger">
        <TriangleAlert size={20} aria-hidden />
      </span>
      <h2 className="text-base font-semibold">Something went wrong</h2>
      <p className="mt-1.5 max-w-md text-sm text-muted">
        We could not load this page. Try again, and if it keeps happening contact support
        {error.digest ? ` with reference ${error.digest}` : ""}.
      </p>
      <Button className="mt-5" onPress={reset}>
        Try again
      </Button>
    </div>
  );
}
