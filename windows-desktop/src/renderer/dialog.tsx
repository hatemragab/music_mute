import { useEffect, useRef, type ReactNode } from "react";
function focusable(dialog: HTMLDialogElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
    ),
  ).filter(
    (element) =>
      !element.matches(":disabled") &&
      !element.closest('[hidden],[inert],[aria-hidden="true"]'),
  );
}
/** Native modal focus trapping with an equivalent headless-test fallback. */
export function ModalDialog({
  label,
  onClose,
  busy = false,
  children,
}: {
  label: string;
  onClose(): void;
  busy?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    dismiss = useRef(onClose),
    blocked = useRef(busy);
  dismiss.current = onClose;
  blocked.current = busy;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    const controls = () => focusable(dialog),
      items = controls();
    (
      items.find((element) =>
        element.hasAttribute("data-dialog-initial-focus"),
      ) ??
      items[0] ??
      dialog
    ).focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!blocked.current) dismiss.current();
      }
      if (event.key !== "Tab") return;
      const items = controls(),
        first = items[0],
        last = items.at(-1);
      if (!first) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", key);
    return () => {
      dialog.removeEventListener("keydown", key);
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      if (
        previous?.isConnected &&
        previous !== document.body &&
        previous !== document.documentElement &&
        !previous.matches(":disabled") &&
        !previous.closest('[hidden],[inert],[aria-hidden="true"]')
      )
        previous.focus();
      else
        document
          .querySelector<HTMLElement>(
            '[data-dialog-return-focus]:not(:disabled),main h1[tabindex="-1"]',
          )
          ?.focus();
    };
  }, []);
  useEffect(() => {
    const dialog = ref.current;
    if (
      busy &&
      dialog &&
      (!dialog.contains(document.activeElement) ||
        (document.activeElement instanceof HTMLElement &&
          document.activeElement.matches(":disabled")))
    )
      dialog.focus();
  }, [busy]);
  return (
    <dialog
      ref={ref}
      className="confirmation"
      aria-label={label}
      aria-modal="true"
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
