// Shared status taxonomy for pending bills. The kicker, activity-
// panel bill row, and section pending-rail all dispatch on
// `bill_status` to pick a tone (Catppuccin token name carried on
// `data-s`) and a short label. Centralizing here keeps the 5-key
// taxonomy DRY across the three surfaces.

import type { BillStatus } from "@/types";

export const STATUS_TONE: Record<BillStatus, string> = {
  filed: "sky",
  committee: "yellow",
  engrossed: "mauve",
  floor: "peach",
  enrolled: "green",
};

export const STATUS_LABEL: Record<BillStatus, string> = {
  filed: "Introduced",
  committee: "Committee",
  engrossed: "1st Reading",
  floor: "Amended",
  enrolled: "Final Pass",
};
