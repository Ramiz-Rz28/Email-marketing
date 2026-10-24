"use server";

import { z } from "zod";
import type { JSONContent } from "@maily-to/render";
import { audit, sql } from "@/lib/db";
import { requireStore } from "@/lib/auth";
import { env } from "@/lib/env";
import { resend } from "@/lib/resend";
import { renderTemplate } from "@/lib/email/render";
import { collectVariables, sampleContext } from "@/lib/email/variables";

export type TemplateSummary = {
  id: string;
  store_id: string | null;
  name: string;
  kind: string;
  subject: string;
  updated_at: Date;
};

export type TemplateFull = TemplateSummary & {
  preheader: string;
  content_json: JSONContent;
  preview_html: string | null;
  variables: string[];
};

const contentSchema = z.object({ type: z.literal("doc"), content: z.array(z.any()).optional() }).passthrough();

const saveSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  subject: z.string().max(300),
  preheader: z.string().max(300),
  content_json: contentSchema,
});

export type SaveTemplateInput = {
  id?: string;
  name: string;
  subject: string;
  preheader: string;
  content_json: JSONContent;
};

const BLANK_DOC: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2, textAlign: "center" }, content: [{ type: "text", text: "Headline" }] },
    { type: "paragraph", attrs: { textAlign: "left" }, content: [{ type: "text", text: "Write your message here. Type @ to insert a variable." }] },
  ],
};

async function renderPreview(
  store: { name: string; brand_logo_url: string | null; brand_primary: string | null; brand_font: string | null },
  content: JSONContent,
  subject: string,
  preheader: string,
) {
  const ctx = sampleContext(store, env().NEXT_PUBLIC_APP_URL);
  return renderTemplate({
    contentJson: content,
    subject,
    preheader,
    store,
    variables: ctx.variables,
    payloads: ctx.payloads,
  });
}

export async function listTemplates(): Promise<TemplateSummary[]> {
  const { store } = await requireStore();
  return sql<TemplateSummary[]>`
    select id, store_id, name, kind, subject, updated_at
    from templates
    where store_id = ${store.id} or store_id is null
    order by (store_id is null), updated_at desc`;
}

export async function getTemplate(id: string): Promise<TemplateFull | null> {
  const { store } = await requireStore();
  if (!z.string().uuid().safeParse(id).success) return null;
  const rows = await sql<TemplateFull[]>`
    select id, store_id, name, kind, subject, preheader, content_json, preview_html, variables, updated_at
    from templates
    where id = ${id} and (store_id = ${store.id} or store_id is null)
    limit 1`;
  return rows[0] ?? null;
}

/** Updates a store template, or copies a global one into the store when `id` is global. */
export async function saveTemplate(input: SaveTemplateInput): Promise<{ id: string; copied: boolean }> {
  const { store, userId } = await requireStore();
  const data = saveSchema.parse(input);
  const content = data.content_json as JSONContent;
  const variables = collectVariables(content);
  const preview = await renderPreview(store, content, data.subject, data.preheader);

  if (data.id) {
    const updated = await sql<{ id: string }[]>`
      update templates set name = ${data.name}, subject = ${data.subject}, preheader = ${data.preheader},
        content_json = ${sql.json(content as never)}, preview_html = ${preview.html}, variables = ${sql.array(variables)}
      where id = ${data.id} and store_id = ${store.id}
      returning id`;
    if (updated.length > 0) {
      await audit(store.id, userId, "template.updated", { type: "template", id: data.id }, { name: data.name });
      return { id: data.id, copied: false };
    }
    // Not ours: allow "save as copy" only for global templates.
    const global = await sql<{ kind: string }[]>`select kind from templates where id = ${data.id} and store_id is null`;
    if (global.length === 0) throw new Error("Template not found");
    const created = await sql<{ id: string }[]>`
      insert into templates (store_id, name, kind, subject, preheader, content_json, preview_html, variables)
      values (${store.id}, ${data.name}, ${global[0].kind}, ${data.subject}, ${data.preheader},
              ${sql.json(content as never)}, ${preview.html}, ${sql.array(variables)})
      returning id`;
    await audit(store.id, userId, "template.updated", { type: "template", id: created[0].id }, { name: data.name, copied_from: data.id });
    return { id: created[0].id, copied: true };
  }

  const created = await sql<{ id: string }[]>`
    insert into templates (store_id, name, kind, subject, preheader, content_json, preview_html, variables)
    values (${store.id}, ${data.name}, 'custom', ${data.subject}, ${data.preheader},
            ${sql.json(content as never)}, ${preview.html}, ${sql.array(variables)})
    returning id`;
  await audit(store.id, userId, "template.updated", { type: "template", id: created[0].id }, { name: data.name, created: true });
  return { id: created[0].id, copied: false };
}

export async function createBlankTemplate(): Promise<{ id: string }> {
  const { store, userId } = await requireStore();
  const preview = await renderPreview(store, BLANK_DOC, "", "");
  const rows = await sql<{ id: string }[]>`
    insert into templates (store_id, name, kind, subject, preheader, content_json, preview_html, variables)
    values (${store.id}, 'Untitled template', 'custom', '', '', ${sql.json(BLANK_DOC as never)}, ${preview.html}, ${sql.array(collectVariables(BLANK_DOC))})
    returning id`;
  await audit(store.id, userId, "template.updated", { type: "template", id: rows[0].id }, { created: true });
  return { id: rows[0].id };
}

export async function duplicateTemplate(id: string): Promise<{ id: string }> {
  const { store, userId } = await requireStore();
  const rows = await sql<{ id: string }[]>`
    insert into templates (store_id, name, kind, subject, preheader, content_json, preview_html, variables)
    select ${store.id}::uuid, name || case when store_id is null then '' else ' (copy)' end, kind, subject, preheader,
           content_json, preview_html, variables
    from templates
    where id = ${id} and (store_id = ${store.id} or store_id is null)
    returning id`;
  if (rows.length === 0) throw new Error("Template not found");
  await audit(store.id, userId, "template.updated", { type: "template", id: rows[0].id }, { duplicated_from: id });
  return { id: rows[0].id };
}

/** Renders unsaved editor content with sample data for the live preview. */
export async function previewTemplate(contentJson: JSONContent, subject: string, preheader: string): Promise<string> {
  const { store } = await requireStore();
  const content = contentSchema.parse(contentJson) as JSONContent;
  const out = await renderPreview(store, content, subject, preheader);
  return out.html;
}

export async function sendTestEmail(templateId: string, toEmail: string): Promise<{ ok: boolean; error?: string }> {
  const { store, userId } = await requireStore();
  const to = z.string().email().safeParse(toEmail.trim());
  if (!to.success) return { ok: false, error: "Enter a valid email address." };
  if (!env().RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY is not configured." };

  const tpl = await getTemplate(templateId);
  if (!tpl) return { ok: false, error: "Template not found." };

  const out = await renderPreview(store, tpl.content_json, tpl.subject, tpl.preheader);
  const from = store.from_email ? `${store.from_name || store.name} <${store.from_email}>` : env().RESEND_FROM_DEFAULT;
  const { error } = await resend.emails.send({
    from,
    to: [to.data],
    subject: `[Test] ${out.subject || tpl.name}`,
    html: out.html,
    text: out.text,
    ...(store.reply_to ? { replyTo: store.reply_to } : {}),
  });
  if (error) return { ok: false, error: error.message };

  await audit(store.id, userId, "template.test_sent", { type: "template", id: templateId }, { to: to.data });
  return { ok: true };
}
