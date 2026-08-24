function normalized(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function resolveNamed(rows, id, name, kind) {
  if (id) {
    const match = rows.find((row) => row.id === id);
    if (!match) throw new Error(`${kind}_id does not belong to this project board`);
    return match;
  }
  if (!name) return null;
  const needle = normalized(name);
  const exact = rows.filter((row) => normalized(row.name) === needle);
  const matches = exact.length ? exact : rows.filter((row) => normalized(row.name).includes(needle));
  if (matches.length !== 1) {
    const choices = rows.map((row) => row.name).join(", ");
    throw new Error(matches.length ? `Ambiguous ${kind} name. Available: ${choices}` : `${kind} not found. Available: ${choices}`);
  }
  return matches[0];
}

function allTasks(board) {
  return (board.columns ?? []).flatMap((column) => column.tasks ?? []);
}

export function resolveBoardTaskUpdate(board, input = {}) {
  if (!board || !Array.isArray(board.columns) || !Array.isArray(board.groups)) {
    throw new Error("Invalid project board response");
  }
  const tasks = allTasks(board);
  let task = input.task_id ? tasks.find((row) => row.id === input.task_id) : null;
  if (!task && input.task_title) {
    const needle = normalized(input.task_title);
    const exact = tasks.filter((row) => normalized(row.title) === needle);
    const matches = exact.length ? exact : tasks.filter((row) => normalized(row.title).includes(needle));
    if (matches.length !== 1) {
      throw new Error(matches.length ? "Task title is ambiguous; provide task_id" : "Task not found on this project board");
    }
    [task] = matches;
  }
  if (!task) throw new Error("Provide an existing task_id or an unambiguous task_title");
  if (!input.expected_updated_at || input.expected_updated_at !== task.updated_at) {
    throw new Error("Board task changed since it was read; refresh the board before editing");
  }

  const column = resolveNamed(board.columns, input.target_column_id, input.target_column_name, "target_column");
  const group = resolveNamed(board.groups, input.phase_group_id, input.phase_group_name, "phase_group");
  const patch = {};
  if (column) patch.column_id = column.id;
  if (group) patch.phase_group_id = group.id;
  for (const field of ["title", "description", "due_date", "due_time"]) {
    if (Object.prototype.hasOwnProperty.call(input, field)) patch[field] = input[field];
  }
  const changedPatch = Object.fromEntries(Object.entries(patch).filter(([key, value]) => task[key] !== value));
  if (!Object.keys(changedPatch).length) {
    return { task, patch: {}, column, group, noOp: true };
  }
  return { task, patch: changedPatch, column, group, noOp: false };
}

export function verifyBoardTaskUpdate(board, taskId, patch) {
  const task = allTasks(board).find((row) => row.id === taskId);
  if (!task) throw new Error("Updated board task was not found during readback");
  for (const [key, value] of Object.entries(patch)) {
    if (task[key] !== value) throw new Error(`Board task readback mismatch for ${key}`);
  }
  return task;
}
