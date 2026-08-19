import type { CreateTaskInput, Task, TaskStatus } from "../domain/task.js";

export interface TaskRepository {
  create(id: string, input: CreateTaskInput): Task;
  findById(id: string): Task | undefined;
  listByStatus(status: TaskStatus): readonly Task[];
  save(task: Task): void;
}
