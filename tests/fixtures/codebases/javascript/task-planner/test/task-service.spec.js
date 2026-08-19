import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTaskRepository, InvalidTaskTransitionError, TaskNotFoundError, TaskService } from "../src/index.js";

const createService = () => new TaskService(new InMemoryTaskRepository());

test("creates sequential todo tasks with normalized titles", () => {
  const service = createService();
  assert.deepEqual(service.createTask({ title: "  Prepare demo  ", assignee: "Avery" }), { id: "task-001", title: "Prepare demo", status: "todo", assignee: "Avery" });
});

test("moves a task through its allowed lifecycle", () => {
  const service = createService();
  const task = service.createTask({ title: "Prepare demo" });
  assert.equal(service.startTask(task.id).status, "in_progress");
  assert.equal(service.completeTask(task.id).status, "done");
});

test("reports missing tasks and invalid transitions", () => {
  const service = createService();
  assert.throws(() => service.startTask("task-404"), TaskNotFoundError);
  const task = service.createTask({ title: "Prepare demo" });
  assert.throws(() => service.completeTask(task.id), InvalidTaskTransitionError);
});
