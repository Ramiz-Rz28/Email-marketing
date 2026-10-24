"use client";

import type { ReactNode } from "react";
import { Button } from "@heroui/react";
import { useFormStatus } from "react-dom";

/** Submit button that shows a pending state while its parent <form action> runs. */
export function SubmitButton({
  children,
  variant = "primary",
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} isPending={pending}>
      {children}
    </Button>
  );
}
