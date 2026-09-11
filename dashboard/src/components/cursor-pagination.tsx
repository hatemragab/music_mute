import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

interface CursorPaginationProps {
  cursor: string | null;
  nextCursor: string | null;
  pending?: boolean;
  onCursorChange(cursor: string | null): void;
}

export function CursorPagination({
  cursor,
  nextCursor,
  pending = false,
  onCursorChange,
}: CursorPaginationProps) {
  const [history, setHistory] = useState<Array<string | null>>([]);
  const currentHistory = cursor ? history : [];

  if (!cursor && !nextCursor) return null;

  return (
    <nav
      aria-label="Results pages"
      className="flex items-center justify-end gap-2 border-t px-4 py-3"
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label="Previous page"
        disabled={pending || currentHistory.length === 0}
        onClick={() => {
          const previous = currentHistory.at(-1) ?? null;
          setHistory(currentHistory.slice(0, -1));
          onCursorChange(previous);
        }}
      >
        <ChevronLeft aria-hidden="true" /> Previous
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label="Next page"
        disabled={pending || !nextCursor}
        onClick={() => {
          if (!nextCursor) return;
          setHistory([...currentHistory, cursor]);
          onCursorChange(nextCursor);
        }}
      >
        Next <ChevronRight aria-hidden="true" />
      </Button>
    </nav>
  );
}
