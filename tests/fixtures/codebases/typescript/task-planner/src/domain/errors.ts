export class TaskNotFoundError extends Error {
  public constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class InvalidTaskTransitionError extends Error {
  public constructor(taskId: string, from: string, to: string) {
    super(`Task ${taskId} cannot transition from ${from} to ${to}`);
    this.name = "InvalidTaskTransitionError";
  }
}
