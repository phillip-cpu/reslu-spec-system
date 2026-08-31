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

export function compactProjectBoard(board, taskQuery) {
  if (!board || !Array.isArray(board.columns) || !Array.isArray(board.groups)) throw new Error("Invalid project board response");
  return {
    columns: board.columns.map((column) => ({
      id: column.id, name: column.name, sort: column.sort, task_count: (column.tasks ?? []).length,
      tasks: (column.tasks ?? []).filter((task) => taskQuery && normalized(task.title).includes(normalized(taskQuery))).map((task) => ({
        id: task.id, title: task.title, column_id: task.column_id, phase_group_id: task.phase_group_id,
        description: task.description, due_date: task.due_date, due_time: task.due_time, updated_at: task.updated_at,
      })),
    })),
    groups: board.groups.map((group) => ({ id: group.id, name: group.name, sort: group.sort, phase_id: group.phase_id, updated_at: group.updated_at })),
  };
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

export function resolveBoardGroupUpdate(board, input = {}) {
  if (!board || !Array.isArray(board.groups)) throw new Error("Invalid project board response");
  const groups = board.groups;
  const group = resolveNamed(groups, input.group_id, input.group_name, "group");
  if (!group) throw new Error("Provide an existing group_id or unambiguous group_name");
  if (!input.expected_updated_at || input.expected_updated_at !== group.updated_at) {
    throw new Error("Board group changed since it was read; refresh the board before editing");
  }
  const relativeKeys = [input.move_after_group_id, input.move_after_group_name, input.move_before_group_id, input.move_before_group_name].filter(Boolean);
  if (relativeKeys.length > 1 || (relativeKeys.length && input.sort !== undefined)) {
    throw new Error("Choose exactly one relative move or an explicit sort value");
  }
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(input, "name")) patch.name = input.name;
  if (input.sort !== undefined) patch.sort = Number(input.sort);

  const after = resolveNamed(groups.filter((row) => row.id !== group.id), input.move_after_group_id, input.move_after_group_name, "move_after_group");
  const before = resolveNamed(groups.filter((row) => row.id !== group.id), input.move_before_group_id, input.move_before_group_name, "move_before_group");
  if (after || before) {
    const ordered = groups.filter((row) => row.id !== group.id).sort((a, b) => Number(a.sort) - Number(b.sort) || a.id.localeCompare(b.id));
    const anchor = after ?? before;
    const index = ordered.findIndex((row) => row.id === anchor.id);
    const previous = after ? anchor : ordered[index - 1];
    const next = after ? ordered[index + 1] : anchor;
    if (previous && next && Number(next.sort) <= Number(previous.sort) + 1) {
      throw new Error("Adjacent groups have no safe sort gap; reorder them in the board UI first");
    }
    patch.sort = previous && next
      ? Math.floor((Number(previous.sort) + Number(next.sort)) / 2)
      : previous
        ? Number(previous.sort) + 1000
        : Number(next.sort) - 1000;
  }
  const changedPatch = Object.fromEntries(Object.entries(patch).filter(([key, value]) => group[key] !== value));
  return { group, patch: changedPatch, noOp: Object.keys(changedPatch).length === 0 };
}

export function verifyBoardGroupUpdate(board, groupId, patch) {
  const group = (board.groups ?? []).find((row) => row.id === groupId);
  if (!group) throw new Error("Updated board group was not found during readback");
  for (const [key, value] of Object.entries(patch)) {
    if (group[key] !== value) throw new Error(`Board group readback mismatch for ${key}`);
  }
  return group;
}
