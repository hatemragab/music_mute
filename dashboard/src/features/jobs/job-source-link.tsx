interface JobSourceLinkProps {
  sourceUrl?: string | null;
  className?: string;
}

export function JobSourceLink({ sourceUrl, className }: JobSourceLinkProps) {
  if (!sourceUrl) return <span className="text-muted-foreground">—</span>;
  return (
    <a
      className={className}
      href={sourceUrl}
      target="_blank"
      rel="noreferrer noopener"
    >
      {sourceUrl}
    </a>
  );
}
