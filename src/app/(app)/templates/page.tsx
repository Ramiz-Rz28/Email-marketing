import Link from "next/link";
import { redirect } from "next/navigation";
import { Button, buttonVariants, Card, Chip } from "@heroui/react";
import { Copy, Pencil, Plus } from "lucide-react";
import { createBlankTemplate, duplicateTemplate, listTemplates } from "@/actions/templates";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  cart_recovery: "Cart recovery",
  second_purchase: "Second purchase",
  winback: "Winback",
  affinity: "Affinity",
  custom: "Custom",
};

async function createAction() {
  "use server";
  const { id } = await createBlankTemplate();
  redirect(`/templates/${id}`);
}

async function duplicateAction(formData: FormData) {
  "use server";
  const { id } = await duplicateTemplate(String(formData.get("id")));
  redirect(`/templates/${id}`);
}

export default async function TemplatesPage() {
  const templates = await listTemplates();
  const fmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Templates</h1>
          <p className="text-sm text-muted">Starter templates for each lifecycle flow, plus your own.</p>
        </div>
        <form action={createAction}>
          <Button type="submit">
            <Plus size={16} />
            New template
          </Button>
        </form>
      </div>

      {templates.length === 0 ? (
        <Card>
          <Card.Header>
            <Card.Title>No templates yet</Card.Title>
            <Card.Description>
              Run <code>npm run db:seed</code> to load the starter templates, or create a blank one.
            </Card.Description>
          </Card.Header>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <Card key={t.id}>
              <Card.Header>
                <Card.Title>{t.name}</Card.Title>
                <Card.Description className="line-clamp-2">{t.subject || "No subject yet"}</Card.Description>
              </Card.Header>
              <Card.Content className="flex flex-wrap items-center gap-2">
                <Chip size="sm" color={t.store_id ? "accent" : "default"}>
                  {KIND_LABEL[t.kind] ?? t.kind}
                </Chip>
                {t.store_id === null ? (
                  <Chip size="sm" variant="soft">
                    Starter
                  </Chip>
                ) : null}
                <span className="text-xs text-muted">Updated {fmt.format(new Date(t.updated_at))}</span>
              </Card.Content>
              <Card.Footer className="flex gap-2">
                <Link href={`/templates/${t.id}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                  <Pencil size={14} />
                  {t.store_id ? "Edit" : "Preview"}
                </Link>
                <form action={duplicateAction}>
                  <input type="hidden" name="id" value={t.id} />
                  <Button type="submit" size="sm" variant="tertiary">
                    <Copy size={14} />
                    Duplicate
                  </Button>
                </form>
              </Card.Footer>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
