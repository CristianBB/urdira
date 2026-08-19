export class TaskNotFoundError extends Error {
  constructor(taskId) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class InvalidTaskTransitionError extends Error {
  constructor(taskId, from, to) {
    super(`Task ${taskId} cannot transition from ${from} to ${to}`);
    this.name = "InvalidTaskTransitionError";
  }
}
