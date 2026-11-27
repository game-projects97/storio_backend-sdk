export type Progress = {
  schema_version: 1;
  stage: number;
  intro_seen: boolean;
};

export type SavedProgress = { version: number; progress: Progress };

export type SaveProgress = {
  expected_version: number;
  request_id: string;
  progress: Progress;
};
