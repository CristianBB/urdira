export type TaskStatus = "todo" | "in_progress" | "done";

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly assignee?: string;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly assignee?: string;
}
