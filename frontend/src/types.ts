export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
export interface Lab {
  id: string;
  title: string;
  description: string;
  archived: boolean;
  revision: number;
  created_at?: string;
  updated_at?: string;
}
export interface Criterion {
  id?: string;
  label: string;
  max_points: string;
  instructions: string;
}
export interface Exercise {
  id: string;
  lab_id: string;
  title: string;
  description: string;
  position: number;
  max_points: string;
  grading_mode: 'manual' | 'criteria';
  grading_instructions: string;
  criteria: Criterion[];
  rubric_revision: number;
  revision: number;
  archived: boolean;
}
export interface Team {
  id: string;
  lab_id: string;
  label: string;
  members: { student_id: string; name: string }[];
  membership_complete: boolean;
  notes: string;
  archived: boolean;
  revision: number;
}
export interface Assessment {
  id: string | null;
  team_id: string;
  exercise_id: string;
  submission_id: string | null;
  status: 'ungraded' | 'draft' | 'final';
  score: string | null;
  criterion_scores: Record<string, string>;
  notes: string;
  source: 'human' | 'agent' | 'import';
  revision: number;
  rubric_revision: number;
  rubric_stale: boolean;
  rubric_snapshot?: unknown;
  created_at?: string;
  updated_at?: string;
}
export interface StoredFile {
  id: string;
  lab_id: string;
  filename: string;
  sha256: string;
  size: number;
  media_type: string;
  created_at: string;
}
export interface Material {
  id: string;
  revision: number;
  lab_id: string;
  exercise_id: string | null;
  file_id: string;
  role: string;
  title: string;
  description: string;
  file?: StoredFile;
}
export interface ArchiveMember {
  path: string;
  size?: number;
  is_dir?: boolean;
  [key: string]: unknown;
}
export interface Submission {
  id: string;
  lab_id: string;
  team_id: string;
  file_id: string;
  filename: string;
  sha256: string;
  created_at: string;
  archive_status: string;
  archive_errors: unknown[];
  members?: ArchiveMember[];
}
export interface Evidence {
  id: string;
  revision: number;
  exercise_id: string;
  team_id: string;
  submission_id: string | null;
  kind: 'text' | 'link' | 'file' | 'result';
  title: string;
  text?: string;
  url?: string;
  file_id?: string;
  data?: unknown;
  source: string;
  created_at: string;
}
export interface OverviewRow {
  team: Team;
  submissions_count: number;
  assessments: Assessment[];
  awarded_points: string | null;
  total_points: string;
  grade_complete: boolean;
}
export interface Overview {
  lab: Lab;
  exercises: Exercise[];
  rows: OverviewRow[];
  total: number;
  limit: number;
  offset: number;
  stats: Record<string, unknown>;
}
