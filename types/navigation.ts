export interface RecentProjectShortcut {
  id: string;
  name: string;
}

export interface NavigationPreferencesResponse {
  sidebar_order: string[];
  recent_projects: RecentProjectShortcut[];
}

