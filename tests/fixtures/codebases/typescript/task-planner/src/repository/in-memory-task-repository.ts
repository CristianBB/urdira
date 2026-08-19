import type { CreateTaskInput, Task, TaskStatus } from "../domain/task.js";
import type { TaskRepository } from "./task-repository.js";

export class InMemoryTaskRepository implements TaskRepository {
  readonly #tasks = new Map<string, Task>();

  public create(id: string, input: CreateTaskInput): Task {
    const task: Task = Object.freeze({
      id,
      title: input.title,
      status: "todo",
      ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
    });
    this.#tasks.set(task.id, task);
    return task;
  }

  public findById(id: string): Task | undefined {
    return this.#tasks.get(id);
  }

  public listByStatus(status: TaskStatus): readonly Task[] {
    return [...this.#tasks.values()]
      .filter((task) => task.status === status)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  public save(task: Task): void {
    this.#tasks.set(task.id, Object.freeze({ ...task }));
  }
}
