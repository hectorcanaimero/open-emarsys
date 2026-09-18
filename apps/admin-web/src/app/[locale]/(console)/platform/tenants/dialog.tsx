'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Minimal accessible modal: focuses itself on open, restores focus to the trigger on close,
 * and closes on Escape. Not the native `<dialog>` element — jsdom doesn't implement
 * `showModal()`, which would make this untestable. Children own their own actions/Cancel button.
 */
export function Dialog({
  open,
  onClose,
  titleId,
  role = 'dialog',
  children,
}: {
  open: boolean;
  onClose: () => void;
  titleId: string;
  role?: 'dialog' | 'alertdialog';
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    panelRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4">
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-md rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg"
      >
        {children}
      </div>
    </div>
  );
}
