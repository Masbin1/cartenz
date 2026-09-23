'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';

export interface ActionMenuItem {
  label: string;
  onSelect?: () => void;
  href?: string;
  icon?: LucideIcon;
  /** `danger` for an action that destroys something. */
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /** Draw a hairline above this item, to separate a group. */
  separated?: boolean;
}

/**
 * Secondary actions, kept out of sight until asked for. Use it when a screen
 * would otherwise show more than two buttons side by side.
 *
 * Opens on click, closes on Escape, on an outside click, and after a choice.
 * Arrow keys move between items.
 */
export function ActionMenu({
  items,
  label = 'More actions',
  trigger,
  align = 'end',
  side = 'bottom',
  block = false,
}: {
  items: ActionMenuItem[];
  /** The accessible name of the trigger; also its visible text when `trigger` is 'button'. */
  label?: string;
  /** 'icon' (default) shows a "…" button; 'button' shows a secondary button with the label. */
  trigger?: 'icon' | 'button' | ReactNode;
  align?: 'start' | 'end';
  /** Which way the menu opens. 'top' for a trigger near the bottom of the screen. */
  side?: 'top' | 'bottom';
  /** Stretch the trigger to the width of its container. */
  block?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;

    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();

    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const moveFocus = (event: ReactKeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const entries = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
    );
    const index = entries.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
    entries[(next + entries.length) % entries.length]?.focus();
  };

  const triggerNode =
    trigger === 'button' ? (
      <span className="btn-secondary">{label}</span>
    ) : trigger && trigger !== 'icon' ? (
      trigger
    ) : (
      <span className="icon-btn">
        <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
      </span>
    );

  const itemClasses = (item: ActionMenuItem) =>
    `flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-callout transition-colors focus:outline-none ${
      item.disabled
        ? 'cursor-not-allowed opacity-40'
        : item.tone === 'danger'
          ? 'text-state-failure hover:bg-state-failure/[0.06] focus:bg-state-failure/[0.06]'
          : 'text-content hover:bg-surface-overlay focus:bg-surface-overlay'
    }`;

  return (
    <div ref={rootRef} className={`relative ${block ? 'flex w-full' : 'inline-flex'}`}>
      <button
        type="button"
        aria-label={trigger === 'button' ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={`rounded-control text-left ${block ? 'w-full' : ''}`}
      >
        {triggerNode}
      </button>

      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          onKeyDown={moveFocus}
          className={`absolute z-30 min-w-[200px] animate-rise-in rounded-xl border border-surface-border bg-surface-raised p-1.5 shadow-float ${
            side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'
          } ${align === 'end' ? 'right-0' : 'left-0'} ${block ? 'w-full' : ''}`}
        >
          {items.map((item) => {
            const Icon = item.icon;
            const content = (
              <>
                {Icon ? <Icon className="h-4 w-4 shrink-0 opacity-70" strokeWidth={1.75} aria-hidden="true" /> : null}
                {item.label}
              </>
            );
            return (
              <div key={item.label} className={item.separated ? 'mt-1.5 border-t border-surface-border pt-1.5' : ''}>
                {item.href && !item.disabled ? (
                  <Link
                    href={item.href}
                    role="menuitem"
                    className={itemClasses(item)}
                    onClick={() => setOpen(false)}
                  >
                    {content}
                  </Link>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    aria-disabled={item.disabled || undefined}
                    className={itemClasses(item)}
                    onClick={() => {
                      if (item.disabled) return;
                      setOpen(false);
                      item.onSelect?.();
                    }}
                  >
                    {content}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
