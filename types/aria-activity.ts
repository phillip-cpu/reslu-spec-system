export interface AriaActivityItem {
  id: string;
  kind: string;
  status: "pending" | "picked_up" | "done" | "failed";
  title: string;
  detail: string | null;
  created_at: string;
  picked_up_at: string | null;
  resolved_at: string | null;
  attempts: number;
  is_exception: boolean;
}

export interface AriaActivityResponse {
  summary: {
    waiting: number;
    working: number;
    failed_7d: number;
    approvals: number;
  };
  items: AriaActivityItem[];
}

