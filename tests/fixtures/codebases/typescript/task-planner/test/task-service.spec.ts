import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryTaskRepository, InvalidTaskTransitionError, TaskNotFoundError, TaskService } from "../src/index.js";

const createService = (): TaskService => new TaskService(new InMemoryTaskRepository());

test("creates sequential todo tasks with normalized titles", () => {
  const service = createService();
  const task = service.createTask({ title: "  Prepare demo  ", assignee: "Avery" });
  assert.deepEqual(task, { id: "task-001", title: "Prepare demo", status: "todo", assignee: "Avery" });
});

test("moves a task through its allowed lifecycle", () => {
  const service = createService();
  const task = service.createTask({ title: "Prepare demo" });
  assert.equal(service.startTask(task.id).status, "in_progress");
  assert.equal(service.completeTask(task.id).status, "done");
});

test("lists open tasks in deterministic identifier order", () => {
  const service = createService();
  const first = service.createTask({ title: "First" });
  const second = service.createTask({ title: "Second" });
  service.startTask(second.id);
  assert.deepEqual(service.getOpenTasks().map((task) => task.id), [first.id, second.id]);
});

test("reports missing tasks and invalid lifecycle transitions", () => {
  const service = createService();
  const task = service.createTask({ title: "Prepare demo" });
  assert.throws(() => service.startTask("task-404"), TaskNotFoundError);
  assert.throws(() => service.completeTask(task.id), InvalidTaskTransitionError);
});
