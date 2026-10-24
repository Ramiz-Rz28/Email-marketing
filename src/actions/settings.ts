"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStore } from "@/lib/auth";
import { audit, sql } from "@/lib/db";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v));

const isTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const SettingsSchema = z.object({
  name: z.string().trim().min(1, "Store name is required").max(120),
  brand_logo_url: optionalText(500).refine((v) => v === null || /^https:\/\/\S+$/.test(v), {
    message: "Logo URL must start with https://",
  }),
  brand_primary: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Brand colour must be a hex value like #111111"),
  brand_font: optionalText(200),
  from_name: optionalText(120),
  from_email: optionalText(254).refine((v) => v === null || z.string().email().safeParse(v).success, {
    message: "From email is not a valid address",
  }),
  reply_to: optionalText(254).refine((v) => v === null || z.string().email().safeParse(v).success, {
    message: "Reply-to is not a valid address",
  }),
  timezone: z.string().trim().min(1).refine(isTimezone, { message: "Unknown timezone" }),
  max_emails_per_customer_per_week: z.coerce
    .number()
    .int("Weekly limit must be a whole number")
    .min(1, "Weekly limit must be at least 1")
    .max(14, "Weekly limit cannot exceed 14"),
});

/** Update brand + sending settings for the current store. Redirects back to /settings with a status flag. */
export async function updateStoreSettings(formData: FormData): Promise<void> {
  const { store, userId } = await requireStore();
  const parsed = SettingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid settings";
    redirect(`/settings?error=${encodeURIComponent(message)}`);
  }
  const v = parsed.data;

  await sql`
    update stores set
      name = ${v.name},
      brand_logo_url = ${v.brand_logo_url},
      brand_primary = ${v.brand_primary},
      brand_font = ${v.brand_font},
      from_name = ${v.from_name},
      from_email = ${v.from_email},
      reply_to = ${v.reply_to},
      timezone = ${v.timezone},
      max_emails_per_customer_per_week = ${v.max_emails_per_customer_per_week}
    where id = ${store.id}`;

  await audit(store.id, userId, "store.updated", { type: "store", id: store.id }, { fields: Object.keys(v) });
  revalidatePath("/", "layout");
  redirect("/settings?saved=1");
}
