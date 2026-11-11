"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { type LoadDraft, LoadForm } from "@/components/load-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { draftFromExtraction } from "@/lib/intake-draft";
import type { CityOption } from "@/server/fleet";
import { extractIntakeAction } from "@/server/intake-actions";

interface Props {
  cities: CityOption[];
  claudeAvailable: boolean;
  maxChars: number;
}

/**
 * Paste a rate confirmation, extract, review the pre-filled form, create.
 * Nothing is saved until the dispatcher clicks Create on the form below.
 */
export function IntakePanel({ cities, claudeAvailable, maxChars }: Props) {
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<LoadDraft | null>(null);
  const [draftKey, setDraftKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [meta, setMeta] = useState<string | null>(null);

  const extract = () =>
    start(async () => {
      const result = await extractIntakeAction({ text });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      const { draft: d, warnings: w } = draftFromExtraction(result.data.extraction, cities);
      setDraft(d);
      setDraftKey((k) => k + 1);
      setWarnings(w);
      setNotice(result.data.notice);
      setMeta(
        `${result.data.extractor === "claude" ? "Claude" : "Regex baseline"} · ${result.data.latencyMs} ms${
          result.data.costUsd !== null ? ` · $${result.data.costUsd.toFixed(5)}` : ""
        }`,
      );
    });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span>Paste a rate confirmation</span>
            <span
              className="text-xs font-normal text-muted-foreground"
              data-testid="intake-extractor"
            >
              {claudeAvailable
                ? "Extractor: Claude (claude-haiku-5-5), regex fallback"
                : "Extractor: regex baseline (no API key set)"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea
            data-testid="intake-text"
            rows={10}
            maxLength={maxChars}
            placeholder="Paste the email or PDF text here…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {text.length.toLocaleString("en-US")} / {maxChars.toLocaleString("en-US")} characters
            </span>
            <Button
              type="button"
              onClick={extract}
              disabled={pending || text.trim().length < 20}
              data-testid="intake-extract"
            >
              {pending ? "Reading…" : "Extract"}
            </Button>
          </div>
          {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
          {notice ? (
            <p
              className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
              data-testid="intake-notice"
            >
              {notice}
            </p>
          ) : null}
          {warnings.length ? (
            <ul className="list-disc pl-5 text-xs text-amber-900" data-testid="intake-warnings">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {draft ? "Review and create" : "Or enter the load by hand"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* The key remounts the form with the new draft after each extraction. */}
          <LoadForm key={draftKey} cities={cities} {...(draft ? { initial: draft } : {})} />
        </CardContent>
      </Card>
    </div>
  );
}
