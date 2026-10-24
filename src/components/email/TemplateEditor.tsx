"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Chip, Description, Input, Label, Modal, Tabs, TextField, buttonVariants } from "@heroui/react";
import { ArrowLeft, Check, Copy, Save, Send } from "lucide-react";
import { Editor } from "@maily-to/core";
import { VariableExtension, getVariableSuggestions, type Variable } from "@maily-to/core/extensions";
import type { JSONContent } from "@maily-to/render";
import { previewTemplate, saveTemplate, sendTestEmail } from "@/actions/templates";
import { ITEM_FIELDS, VARIABLES } from "@/lib/email/variables";

type EditorTemplate = {
  id: string;
  name: string;
  kind: string;
  subject: string;
  preheader: string;
  content_json: JSONContent;
  preview_html: string | null;
  isGlobal: boolean;
};

const FLAT: Variable[] = [
  ...VARIABLES.filter((v) => v.kind === "string").map((v) => ({ name: v.name, required: false })),
  ...ITEM_FIELDS.map((f) => ({ name: f.name, required: false })),
];
const REPEAT_KEYS: Variable[] = VARIABLES.filter((v) => v.kind === "array").map((v) => ({ name: v.name, required: true }));

/** Scales a fixed-width email into whatever room the column has. */
function PreviewFrame({ html, width }: { html: string; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const height = 960;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setScale(Math.min(1, entry.contentRect.width / width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  return (
    <div ref={ref} className="w-full overflow-hidden rounded-lg border border-border bg-white" style={{ height: height * scale }}>
      <iframe
        title="Email preview"
        srcDoc={html}
        sandbox=""
        style={{ width, height, border: 0, transform: `scale(${scale})`, transformOrigin: "top left" }}
      />
    </div>
  );
}

function VariableRow({ name, description }: { name: string; description: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <li className="flex items-start justify-between gap-2 border-b border-separator py-2 last:border-b-0">
      <div className="min-w-0">
        <code className="block truncate text-xs font-medium text-foreground">{name}</code>
        <span className="block text-xs text-muted">{description}</span>
      </div>
      <Button isIconOnly size="sm" variant="ghost" aria-label={`Copy ${name}`} onPress={copy}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </Button>
    </li>
  );
}

export function TemplateEditor({ template, storeName }: { template: EditorTemplate; storeName: string }) {
  const router = useRouter();
  const initialContent = useRef(template.content_json);
  const [json, setJson] = useState<JSONContent>(template.content_json);
  const [name, setName] = useState(template.name);
  const [subject, setSubject] = useState(template.subject);
  const [preheader, setPreheader] = useState(template.preheader);
  const [previewHtml, setPreviewHtml] = useState(template.preview_html ?? "");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [dirty, setDirty] = useState(false);
  const [saving, startSave] = useTransition();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const [testOpen, setTestOpen] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testing, startTest] = useTransition();
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Maily's `@` picker. For repeat blocks it offers the array keys; elsewhere the flat
  // variables plus the per-item fields (title, image, price, url, quantity).
  const extensions = useMemo(
    () => [
      VariableExtension.configure({
        suggestion: getVariableSuggestions("@"),
        variables: ({ query, from }) => {
          const q = query.toLowerCase();
          const pool = from === "repeat-variable" ? REPEAT_KEYS : FLAT;
          return pool.filter((v) => v.name.toLowerCase().includes(q));
        },
      }),
    ],
    [],
  );

  // Live preview, debounced; stale responses are dropped.
  const requestId = useRef(0);
  useEffect(() => {
    if (!dirty) return;
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      try {
        const html = await previewTemplate(json, subject, preheader);
        if (id === requestId.current) setPreviewHtml(html);
      } catch {
        /* keep last good preview */
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [json, subject, preheader, dirty]);

  const touch = useCallback(() => {
    setDirty(true);
    setMessage(null);
  }, []);

  const onSave = () => {
    startSave(async () => {
      try {
        const res = await saveTemplate({ id: template.id, name, subject, preheader, content_json: json });
        setDirty(false);
        if (res.copied) {
          router.replace(`/templates/${res.id}`);
        } else {
          setMessage({ kind: "ok", text: "Saved" });
          router.refresh();
        }
      } catch (e) {
        setMessage({ kind: "error", text: e instanceof Error ? e.message : "Could not save" });
      }
    });
  };

  const onSendTest = () => {
    setTestResult(null);
    startTest(async () => {
      const res = await sendTestEmail(template.id, testEmail);
      setTestResult(res.ok ? { ok: true, text: `Test sent to ${testEmail}` } : { ok: false, text: res.error ?? "Could not send" });
    });
  };

  return (
    <div className="flex min-h-dvh flex-col gap-4 p-4 lg:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/templates" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            <ArrowLeft size={14} />
            Templates
          </Link>
          <h1 className="text-lg font-semibold text-foreground">{name || "Untitled template"}</h1>
          {template.isGlobal ? <Chip size="sm">Starter</Chip> : null}
          {dirty ? (
            <Chip size="sm" color="warning" variant="soft">
              Unsaved
            </Chip>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {message ? (
            <span className={message.kind === "ok" ? "text-sm text-success" : "text-sm text-danger"}>{message.text}</span>
          ) : null}
          <Button variant="secondary" onPress={() => setTestOpen(true)}>
            <Send size={14} />
            Send test
          </Button>
          <Button onPress={onSave} isPending={saving}>
            <Save size={14} />
            {template.isGlobal ? "Save as my copy" : "Save"}
          </Button>
        </div>
      </header>

      <div className="grid flex-1 items-start gap-4 xl:grid-cols-[240px_minmax(0,1fr)_400px]">
        {/* Variables */}
        <aside className="rounded-xl border border-border bg-surface p-4 xl:sticky xl:top-4 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto">
          <h2 className="text-sm font-semibold text-foreground">Variables</h2>
          <p className="mt-1 text-xs text-muted">
            Type <kbd className="rounded bg-default px-1">@</kbd> in the editor to open the variable picker. Use the copy
            button to grab an exact name for a button link or a repeat block.
          </p>
          <ul className="mt-3">
            {VARIABLES.map((v) => (
              <VariableRow key={v.name} name={v.name} description={v.description} />
            ))}
          </ul>
          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Inside a repeat block</h3>
          <ul className="mt-1">
            {ITEM_FIELDS.map((f) => (
              <VariableRow key={f.name} name={f.name} description={f.description} />
            ))}
          </ul>
        </aside>

        {/* Editor */}
        <section className="min-w-0">
          <div className="maily-editor min-h-[560px] rounded-xl border border-border bg-white text-neutral-900">
            <Editor
              contentJson={initialContent.current}
              extensions={extensions}
              onUpdate={(editor) => {
                setJson(editor.getJSON());
                touch();
              }}
              config={{ hasMenuBar: true, wrapClassName: "maily-wrap", autofocus: false }}
            />
          </div>
        </section>

        {/* Settings + preview */}
        <aside className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
            <TextField
              className="w-full"
              value={name}
              onChange={(v) => {
                setName(v);
                touch();
              }}
            >
              <Label>Name</Label>
              <Input />
            </TextField>
            <TextField
              className="w-full"
              value={subject}
              onChange={(v) => {
                setSubject(v);
                touch();
              }}
            >
              <Label>Subject</Label>
              <Input placeholder="Your bag is waiting, {{customer.first_name,fallback=friend}}" />
              <Description>Supports {"{{variable}}"} and {"{{variable,fallback=text}}"}.</Description>
            </TextField>
            <TextField
              className="w-full"
              value={preheader}
              onChange={(v) => {
                setPreheader(v);
                touch();
              }}
            >
              <Label>Preheader</Label>
              <Input placeholder="Short preview text shown after the subject" />
            </TextField>
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
            <Tabs selectedKey={device} onSelectionChange={(k) => setDevice(String(k) === "mobile" ? "mobile" : "desktop")}>
              <Tabs.ListContainer>
                <Tabs.List aria-label="Preview device">
                  <Tabs.Tab id="desktop">
                    Desktop
                    <Tabs.Indicator />
                  </Tabs.Tab>
                  <Tabs.Tab id="mobile">
                    Mobile
                    <Tabs.Indicator />
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.ListContainer>
              <Tabs.Panel id="desktop">
                <PreviewFrame html={previewHtml} width={600} />
              </Tabs.Panel>
              <Tabs.Panel id="mobile">
                <PreviewFrame html={previewHtml} width={375} />
              </Tabs.Panel>
            </Tabs>
            <p className="text-xs text-muted">Preview uses sample data for {storeName}.</p>
          </div>
        </aside>
      </div>

      <Modal.Backdrop isOpen={testOpen} onOpenChange={setTestOpen}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-[420px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Send a test email</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <TextField className="w-full" type="email" value={testEmail} onChange={setTestEmail}>
                <Label>Send to</Label>
                <Input placeholder="you@microsoft.com" />
                <Description>Sends the last saved version with sample data.</Description>
              </TextField>
              {testResult ? (
                <p className={testResult.ok ? "mt-3 text-sm text-success" : "mt-3 text-sm text-danger"}>{testResult.text}</p>
              ) : null}
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="secondary">
                Close
              </Button>
              <Button onPress={onSendTest} isPending={testing} isDisabled={!testEmail.includes("@")}>
                Send test
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
}
