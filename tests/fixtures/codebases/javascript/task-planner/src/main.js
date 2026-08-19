import { InMemoryTaskRepository, TaskService } from "./index.js";

const repository = new InMemoryTaskRepository();
const tasks = new TaskService(repository);
const draftRelease = tasks.createTask({ title: "Draft release notes", assignee: "Avery" });
const reviewPullRequest = tasks.createTask({ title: "Review pull request" });
tasks.startTask(draftRelease.id);
tasks.completeTask(draftRelease.id);
console.log(`Open task: ${tasks.getOpenTasks()[0]?.title ?? reviewPullRequest.title}`);
