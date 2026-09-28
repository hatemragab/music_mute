import type { SVGProps } from "react";

export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 108 108" aria-hidden="true" focusable="false" {...props}>
      <rect width="108" height="108" fill="#123c37" />
      <g fill="none" stroke="#96e6c7" strokeLinecap="round">
        <path d="M24 49v10M84 49v10" strokeWidth="6" opacity="0.24" />
        <path d="M34 43v22M74 43v22" strokeWidth="7" opacity="0.38" />
        <path d="M44 36v36M64 36v36" strokeWidth="8" opacity="0.56" />
        <path d="M54 25v58" strokeWidth="12" />
      </g>
    </svg>
  );
}
