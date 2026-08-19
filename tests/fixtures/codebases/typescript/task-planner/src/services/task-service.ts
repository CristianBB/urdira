import { InvalidTaskTransitionError, TaskNotFoundError } from "../domain/errors.js";
import type { CreateTaskInput, Task, TaskStatus } from "../domain/task.js";
import type { TaskRepository } from "../repository/task-repository.js";

export class TaskService {
  #nextId = 1;

  public constructor(private readonly repository: TaskRepository) {}

  public createTask(input: CreateTaskInput): Task {
    const title = input.title.trim();
    if (title.length === 0) throw new Error("Task title must not be empty.");
    const id = `task-${String(this.#nextId++).padStart(3, "0")}`;
    return this.repository.create(id, { ...input, title });
  }

  public startTask(taskId: string): Task {
    return this.transition(taskId, "todo", "in_progress");
  }

  public completeTask(taskId: string): Task {
    return this.transition(taskId, "in_progress", "done");
  }

  public getOpenTasks(): readonly Task[] {
    return [...this.repository.listByStatus("todo"), ...this.repository.listByStatus("in_progress")]
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private transition(taskId: string, expected: TaskStatus, next: TaskStatus): Task {
    const task = this.repository.findById(taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    if (task.status !== expected) {
      throw new InvalidTaskTransitionError(taskId, task.status, next);
    }
    const updated: Task = Object.freeze({ ...task, status: next });
    this.repository.save(updated);
    return updated;
  }
}
