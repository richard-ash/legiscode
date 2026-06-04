// Shared status taxonomy for session bills. The kicker, activity-
// panel bill row, and section pending-rail all dispatch on
// `bill_status` to pick a tone (Catppuccin token name carried on
// `data-s`) and a short label. Centralizing here keeps the 9-key
// taxonomy DRY across the three surfaces.

import type { BillStatus } from "@/types";

export const STATUS_TONE: Record<BillStatus, string> = {
  // In-flight (pre-passage).
  filed: "sky",
  committee: "yellow",
  engrossed: "mauve",
  floor: "peach",
  enrolled: "green",
  // Terminal — session bills that won't move further.
  enacted: "teal",
  vetoed: "red",
  withdrawn: "overlay0",
  failed: "overlay0",
};

export const STATUS_LABEL: Record<BillStatus, string> = {
  // In-flight.
  filed: "Introduced",
  committee: "Committee",
  engrossed: "1st Reading",
  floor: "Amended",
  enrolled: "Final Pass",
  // Terminal.
  enacted: "Signed",
  vetoed: "Vetoed",
  withdrawn: "Withdrawn",
  failed: "Failed",
};
