import { InvalidTaskTransitionError, TaskNotFoundError } from "../domain/errors.js";

export class TaskService {
  #nextId = 1;

  /** @param {import("../repository/task-repository.js").TaskRepository} repository */
  constructor(repository) { this.repository = repository; }

  createTask(input) {
    const title = input.title.trim();
    if (title.length === 0) throw new Error("Task title must not be empty.");
    const id = `task-${String(this.#nextId++).padStart(3, "0")}`;
    return this.repository.create(id, { ...input, title });
  }

  startTask(taskId) { return this.transition(taskId, "todo", "in_progress"); }

  completeTask(taskId) { return this.transition(taskId, "in_progress", "done"); }

  getOpenTasks() {
    return [...this.repository.listByStatus("todo"), ...this.repository.listByStatus("in_progress")]
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  transition(taskId, expected, next) {
    const task = this.repository.findById(taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    if (task.status !== expected) throw new InvalidTaskTransitionError(taskId, task.status, next);
    const updated = Object.freeze({ ...task, status: next });
    this.repository.save(updated);
    return updated;
  }
}
