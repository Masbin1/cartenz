"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Plus, Sparkles, X } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import type { SetupConfigurationItem, SetupGap } from "@/lib/types";

/**
 * The fit-gap review (ADR-073 §4). After modules are chosen, suggests the
 * standard configuration the brief implies and the gaps nothing standard
 * covers. Every configuration entry starts ticked and can be unticked or moved
 * to Gap; gaps can be removed or added by hand. Nothing here touches a
 * database: what is ticked is sent with Create, re-checked by the backend
 * against the same menu, and applied after the modules are installed.
 */
export function SetupReview({
  version,
  edition,
  brief,
  modules,
  configuration,
  onConfigurationChange,
  gaps,
  onGapsChange,
}: {
  version: string;
  edition: string;
  brief: string;
  /** The modules chosen in the picker; the setup menu is scoped to them. */
  modules: string[];
  configuration: SetupConfigurationItem[];
  onConfigurationChange: (items: SetupConfigurationItem[]) => void;
  gaps: SetupGap[];
  onGapsChange: (gaps: SetupGap[]) => void;
}) {
  const [tab, setTab] = useState<"configuration" | "gaps">("configuration");
  const [suggested, setSuggested] = useState<SetupConfigurationItem[]>([]);
  const [recommending, setRecommending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newGap, setNewGap] = useState("");

  /** A different version, edition or module set makes an old suggestion stale. */
  useEffect(() => {
    setSuggested([]);
    onConfigurationChange([]);
    onGapsChange([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, edition, modules.join(",")]);

  const recommend = async () => {
    setRecommending(true);
    setError(null);
    try {
      const plan = await api.settings.recommendOdooSetup(
        version,
        edition,
        brief,
        modules,
      );
      setSuggested(plan.configuration);
      onConfigurationChange(plan.configuration);
      onGapsChange(plan.gaps);
      if (plan.configuration.length === 0 && plan.gaps.length === 0) {
        setError("Nothing to configure was found in the brief for these modules.");
      }
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "A setup could not be suggested. You can create the project without one.",
      );
    } finally {
      setRecommending(false);
    }
  };

  const isOn = (item: SetupConfigurationItem) => configuration.includes(item);

  const toggle = (item: SetupConfigurationItem) =>
    onConfigurationChange(
      isOn(item)
        ? configuration.filter((entry) => entry !== item)
        : suggested.filter((entry) => entry === item || configuration.includes(entry)),
    );

  /** Moves a configuration entry to Gap: someone decided standard Odoo is not enough. */
  const moveToGap = (item: SetupConfigurationItem) => {
    setSuggested(suggested.filter((entry) => entry !== item));
    onConfigurationChange(configuration.filter((entry) => entry !== item));
    onGapsChange([...gaps, { title: describe(item), detail: item.reason }]);
  };

  const addGap = () => {
    const title = newGap.trim();
    if (!title) return;
    onGapsChange([...gaps, { title }]);
    setNewGap("");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-meta text-content-subtle">
          {modules.length === 0
            ? "Choose modules first; the setup is scoped to them."
            : "Suggest the standard settings and records the brief implies, and what is left as a gap."}
        </p>
        <button
          type="button"
          onClick={recommend}
          disabled={!brief.trim() || modules.length === 0 || recommending}
          className="btn-secondary btn-sm shrink-0"
        >
          <Sparkles className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          {recommending ? "Suggesting…" : "Suggest setup from brief"}
        </button>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="panel overflow-hidden">
        <div className="flex border-b border-surface-border" role="tablist">
          {(
            [
              ["configuration", `Configuration (${configuration.length}/${suggested.length})`],
              ["gaps", `Gap (${gaps.length})`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`px-4 py-3 text-callout ${
                tab === key
                  ? "border-b-2 border-accent font-medium text-content"
                  : "text-content-muted"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "configuration" ? (
          <ul className="max-h-96 overflow-y-auto p-1.5">
            {suggested.length === 0 ? (
              <li className="px-4 py-8 text-center text-callout text-content-muted">
                No configuration suggested yet.
              </li>
            ) : (
              suggested.map((item, index) => (
                <li
                  key={index}
                  className="flex items-start gap-3.5 rounded-lg px-3 py-2.5 hover:bg-surface-overlay/70"
                >
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0"
                    checked={isOn(item)}
                    onChange={() => toggle(item)}
                    aria-label={describe(item)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-callout font-medium text-content">
                      {describe(item)}
                    </span>
                    <span className="mt-0.5 block font-mono text-caption text-content-subtle">
                      {item.kind}
                      {item.model ? ` · ${item.model}` : ""}
                    </span>
                    {item.reason ? (
                      <span className="mt-0.5 block text-meta text-accent">{item.reason}</span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => moveToGap(item)}
                    className="btn-ghost btn-sm shrink-0"
                    title="Standard configuration is not enough; treat as a gap"
                  >
                    To gap
                    <ArrowRight className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : (
          <div className="p-1.5">
            <ul className="max-h-80 overflow-y-auto">
              {gaps.length === 0 ? (
                <li className="px-4 py-8 text-center text-callout text-content-muted">
                  No gaps. Everything the brief needs is covered by modules and configuration.
                </li>
              ) : (
                gaps.map((gap, index) => (
                  <li
                    key={index}
                    className="flex items-start gap-3.5 rounded-lg px-3 py-2.5 hover:bg-surface-overlay/70"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-callout font-medium text-content">
                        {gap.title}
                      </span>
                      {gap.detail ? (
                        <span className="mt-0.5 block text-meta text-content-subtle">
                          {gap.detail}
                        </span>
                      ) : null}
                    </span>
                    <button
                      type="button"
                      onClick={() => onGapsChange(gaps.filter((_, i) => i !== index))}
                      className="btn-ghost btn-sm shrink-0"
                      aria-label={`Remove ${gap.title}`}
                    >
                      <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </li>
                ))
              )}
            </ul>
            <div className="flex gap-2 border-t border-surface-border p-3">
              <label htmlFor="new-gap" className="sr-only">
                Add a gap
              </label>
              <input
                id="new-gap"
                value={newGap}
                onChange={(event) => setNewGap(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addGap();
                  }
                }}
                className="field-input flex-1 py-2 text-callout"
                placeholder="A requirement standard Odoo does not cover"
                maxLength={200}
              />
              <button type="button" onClick={addGap} className="btn-secondary btn-sm">
                <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                Add
              </button>
            </div>
          </div>
        )}

        <div className="border-t border-surface-border px-4 py-3 text-meta text-content-subtle">
          Ticked configuration is applied after the modules are installed. Gaps become
          requirements (REQ-NNN) in the project specification.
        </div>
      </div>
    </div>
  );
}

/** A human label for one configuration entry. */
function describe(item: SetupConfigurationItem): string {
  switch (item.kind) {
    case "setting":
      return `Enable ${item.settingField ?? "setting"}`;
    case "language":
      return `Install language ${item.languageCode ?? ""}`.trim();
    case "company":
      return `Company: ${Object.entries(item.values ?? {})
        .map(([key, value]) => `${key} = ${String(value)}`)
        .join(", ")}`;
    case "record": {
      const name = item.values?.name ?? item.values?.code ?? "";
      const extra = item.attributeValues?.length ? ` (${item.attributeValues.join(", ")})` : "";
      return `${item.model ?? "record"}: ${String(name)}${extra}`;
    }
  }
}
