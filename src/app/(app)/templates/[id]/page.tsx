import { notFound } from "next/navigation";
import { getTemplate } from "@/actions/templates";
import { requireStore } from "@/lib/auth";
import { TemplateEditor } from "@/components/email/TemplateEditor";

export const dynamic = "force-dynamic";

export default async function TemplateEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store } = await requireStore();
  const template = await getTemplate(id);
  if (!template) notFound();

  return (
    <TemplateEditor
      template={{
        id: template.id,
        name: template.name,
        kind: template.kind,
        subject: template.subject,
        preheader: template.preheader,
        content_json: template.content_json,
        preview_html: template.preview_html,
        isGlobal: template.store_id === null,
      }}
      storeName={store.name}
    />
  );
}
