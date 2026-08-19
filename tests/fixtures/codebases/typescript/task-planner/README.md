# Task Planner

`task-planner` is a small strict TypeScript project used as an Urdira
end-to-end indexing fixture. It models task creation and deterministic
`todo` → `in_progress` → `done` transitions behind a repository interface and
an in-memory adapter.

Run the fixture with:

```bash
npm install
npm test
npm start
```

The project has no runtime dependencies. Its tests cover identifier
generation, lifecycle transitions, deterministic open-task ordering, missing
tasks, and invalid transitions.
