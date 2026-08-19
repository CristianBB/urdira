/**
 * @typedef {import("../domain/task.js").Task} Task
 * @typedef {import("../domain/task.js").CreateTaskInput} CreateTaskInput
 * @typedef {import("../domain/task.js").TaskStatus} TaskStatus
 */

/** @interface */
export class TaskRepository {
  /** @param {string} _id @param {CreateTaskInput} _input @returns {Task} */
  create(_id, _input) { throw new Error("TaskRepository.create is abstract"); }
  /** @param {string} _id @returns {Task | undefined} */
  findById(_id) { throw new Error("TaskRepository.findById is abstract"); }
  /** @param {TaskStatus} _status @returns {readonly Task[]} */
  listByStatus(_status) { throw new Error("TaskRepository.listByStatus is abstract"); }
  /** @param {Task} _task */
  save(_task) { throw new Error("TaskRepository.save is abstract"); }
}
