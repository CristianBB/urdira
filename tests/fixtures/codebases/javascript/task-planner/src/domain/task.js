/** @typedef {"todo" | "in_progress" | "done"} TaskStatus */

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {string} title
 * @property {TaskStatus} status
 * @property {string=} assignee
 */

/**
 * @typedef {object} CreateTaskInput
 * @property {string} title
 * @property {string=} assignee
 */

export {};
