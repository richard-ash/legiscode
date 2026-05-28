// LegisCode icon set, ported from the Claude Design handoff
// (`legiscode/project/icons.jsx`). Same 16px stroke grid; same path
// definitions. All paths are static literals — no user input crosses this
// boundary, so the inner-HTML pattern is safe and keeps the icon registry
// to a single source of truth alongside the upstream prototype.

import type { CSSProperties } from "react";

export interface IconProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: CSSProperties;
  className?: string;
  /** Optional aria-label; when set, role="img" is applied. */
  label?: string;
}

function makeIcon(paths: string, viewBox = "0 0 16 16") {
  return ({
    size = 16,
    color = "currentColor",
    strokeWidth = 1.4,
    style,
    className,
    label,
  }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      className={className}
      role={label ? "img" : "presentation"}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static literal paths from icons.jsx, no user input
      dangerouslySetInnerHTML={{ __html: paths }}
    />
  );
}

export const Icons = {
  Search: makeIcon('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>'),
  Chevron: makeIcon('<path d="M6 3l4 5-4 5"/>'),
  ChevronDown: makeIcon('<path d="M3 6l5 4 5-4"/>'),
  Folder: makeIcon(
    '<path d="M2 4.5c0-.8.6-1.5 1.5-1.5h2.3c.3 0 .6.1.8.3L8 4.5h4.5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5v-7z"/>',
  ),
  FolderOpen: makeIcon(
    '<path d="M2 4.5c0-.8.6-1.5 1.5-1.5h2.3c.3 0 .6.1.8.3L8 4.5h4.5c.8 0 1.5.7 1.5 1.5V7M2 12V6h11.5c.8 0 1.3.8 1 1.6l-1.3 3.7c-.2.6-.8 1-1.5 1H3.5c-.8 0-1.5-.7-1.5-1.5z"/>',
  ),
  Book: makeIcon(
    '<path d="M3 2.5A1.5 1.5 0 0 1 4.5 1H13v11H4.5A1.5 1.5 0 0 0 3 13.5zM3 13.5A1.5 1.5 0 0 0 4.5 15H13"/>',
  ),
  Section: makeIcon(
    '<path d="M10 4.5c0-1-.8-1.8-2-1.8s-2 .8-2 1.5 1 1.2 2.5 1.8 2.5 1.2 2.5 2.5c0 1-.8 1.8-2 1.8M6 11.5c0 1 .8 1.8 2 1.8s2-.8 2-1.5-1-1.2-2.5-1.8-2.5-1.2-2.5-2.5c0-1 .8-1.8 2-1.8M5 13.5S6 14.5 8 14.5s3-1 3-1"/>',
  ),
  Tree: makeIcon(
    '<path d="M3 3h3v3H3zM10 3h3v3h-3zM10 10h3v3h-3zM4.5 6v2a1 1 0 0 0 1 1H10M11.5 6v4"/>',
  ),
  Settings: makeIcon(
    '<circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M3 3l1.4 1.4M11.6 11.6 13 13M1 8h2M13 8h2M3 13l1.4-1.4M11.6 4.4 13 3"/>',
  ),
  Command: makeIcon(
    '<path d="M5 3.5A1.5 1.5 0 1 1 6.5 5v6A1.5 1.5 0 1 1 5 12.5M11 3.5A1.5 1.5 0 1 0 9.5 5v6A1.5 1.5 0 1 0 11 12.5"/><path d="M6.5 5h3M6.5 11h3M6.5 8h3"/>',
  ),
  Close: makeIcon('<path d="M4 4l8 8M12 4l-8 8"/>'),
};

export type IconName = keyof typeof Icons;
