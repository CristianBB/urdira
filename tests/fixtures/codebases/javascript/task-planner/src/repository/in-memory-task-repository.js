import { TaskRepository } from "./task-repository.js";

export class InMemoryTaskRepository extends TaskRepository {
  #tasks = new Map();

  create(id, input) {
    const task = Object.freeze({ id, title: input.title, status: "todo", ...(input.assignee === undefined ? {} : { assignee: input.assignee }) });
    this.#tasks.set(task.id, task);
    return task;
  }

  findById(id) { return this.#tasks.get(id); }

  listByStatus(status) {
    return [...this.#tasks.values()].filter((task) => task.status === status).sort((left, right) => left.id.localeCompare(right.id));
  }

  save(task) { this.#tasks.set(task.id, Object.freeze({ ...task })); }
}
