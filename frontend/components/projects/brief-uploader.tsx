"use client";

import { useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { Alert } from "@/components/ui/alert";

/**
 * Reads a project brief out of an uploaded DOCX, PDF or Markdown/text file
 * (ADR-073 addendum). The call only extracts text; nothing is stored and no
 * project exists yet - the extracted text replaces the brief textarea, which
 * the person still reviews and can edit before Create.
 *
 * Replacing rather than appending: a brief document is a self-contained
 * requirements statement, not a note to add to one already being typed, and
 * silently concatenating two briefs is more likely to confuse than help.
 */
export function BriefUploader({
  onExtracted,
  hasExistingText,
}: {
  onExtracted: (text: string) => void;
  /** Whether the brief field already has text, so a replace can be confirmed. */
  hasExistingText: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    if (
      hasExistingText &&
      !window.confirm(
        `Replace the current brief with the text extracted from "${file.name}"?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.projects.extractBrief(file);
      onExtracted(result.text);
      setNotice(
        result.truncated
          ? `Loaded from ${file.name}. The document was ${result.originalLength.toLocaleString()} characters; the brief was cut to fit the limit. Review the end of the text.`
          : `Loaded from ${file.name}.`,
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "The file could not be read. Try pasting the brief as text instead.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept=".docx,.pdf,.md,.markdown,.txt,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void handleFile(file);
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="btn-secondary btn-sm"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <FileUp className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        )}
        {busy ? "Reading…" : "Upload a brief (DOCX, PDF, Markdown)"}
      </button>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice && !error ? (
        <p className="text-meta text-content-subtle">{notice}</p>
      ) : null}
    </div>
  );
}
