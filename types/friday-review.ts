export type FridayReviewStatus = "draft" | "completed";
export type FridayProjectReviewStatus = "not_started" | "in_progress" | "complete";

export interface FridayReviewProject {
  id: string;
  review_id: string;
  project_id: string;
  review_status: FridayProjectReviewStatus;
  this_week: string;
  next_week: string;
  blockers: string;
  client_update: string;
  action_items: string[];
  client_worthy: boolean;
  no_update: boolean;
  office_task_ids: string[];
  diary_update_id: string | null;
  aria_queue_id: string | null;
  created_at: string;
  updated_at: string;
  project: {
    id: string;
    name: string;
    client_name: string;
    address: string | null;
    job_number: string | null;
  };
  diary_status: string | null;
}

export interface FridayReview {
  id: string;
  week_ending: string;
  status: FridayReviewStatus;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  projects: FridayReviewProject[];
}

export interface FridayReviewResponse {
  review: FridayReview;
}
