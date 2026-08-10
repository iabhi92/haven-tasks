// Pure CSV parsing + column-aliasing for importing tasks exported from other
// task apps (Todoist, TickTick, generic spreadsheet exports, etc.) — no IO,
// no app.js state. See docs/ARCHITECTURE.md "CSV import" for the honest
// scope note: this is alias-based best-effort mapping, not a maintained
// per-app format integration, since export schemas vary by app and change
// over time without notice.

// RFC 4180-ish: handles quoted fields (so a comma or newline inside a
// quoted field doesn't split the row), and "" as an escaped quote within a
// quoted field. Doesn't handle every CSV dialect in existence (e.g. some
// apps use semicolons in certain locales) — the common comma-delimited,
// double-quote-escaped case every major task app's exporter produces.
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

// Header name -> Haven field, matched after lowercasing and stripping
// spaces/underscores/hyphens, so "Due Date", "due_date", and "DueDate" all
// resolve the same way.
const HEADER_ALIASES = {
  title: "title",
  content: "title",
  task: "title",
  name: "title",
  summary: "title",
  notes: "notes",
  note: "notes",
  description: "notes",
  desc: "notes",
  details: "notes",
  priority: "priority",
  duedate: "dueDate",
  due: "dueDate",
  date: "dueDate",
  deadline: "dueDate",
  status: "status",
  completed: "status",
  done: "status",
  tags: "tags",
  labels: "tags",
  tag: "tags",
  label: "tags",
  project: "project",
  list: "project",
  section: "project",
};

function normalizeHeaderKey(header) {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

// Todoist's CSV priority is numeric and inverted (4 = P1/urgent ... 1 =
// P4/none) — this is a best-effort heuristic for that scale, not a
// guaranteed-correct mapping for every app's own numbering.
function normalizePriority(value) {
  const v = String(value).trim().toLowerCase();
  if (["high", "urgent", "p1", "4"].includes(v)) return "high";
  if (["low", "p4", "none", "1", ""].includes(v)) return "low";
  if (["medium", "normal", "p2", "p3", "2", "3"].includes(v)) return "medium";
  return "medium";
}

function normalizeStatus(value) {
  const v = String(value).trim().toLowerCase();
  if (["done", "true", "yes", "1", "completed", "closed"].includes(v)) return "done";
  if (["in progress", "in-progress", "doing", "started"].includes(v)) return "in-progress";
  return "todo";
}

// Accepts common date shapes (YYYY-MM-DD already, or M/D/YYYY, or a full
// ISO timestamp with a time component) and normalizes to Haven's plain
// "YYYY-MM-DD" — dates that don't parse cleanly are dropped (null) rather
// than guessed at, since a wrong due date is worse than a missing one.
function normalizeDueDate(value) {
  if (!value || !value.trim()) return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const usMatch = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (usMatch) {
    const [, m, d, y] = usMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const parsed = new Date(v);
  if (!isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
  }
  return null;
}

// Row -> a partial task-shaped object (still needs id/order/timestamps
// filled in by the caller, same as any other imported task). Returns null
// for a row with no usable title — nothing meaningful to import.
export function csvRowToTask(row) {
  if (!row.title || !row.title.trim()) return null;
  return {
    title: row.title.trim(),
    notes: row.notes ? row.notes.trim() : "",
    status: row.status ? normalizeStatus(row.status) : "todo",
    priority: row.priority ? normalizePriority(row.priority) : "medium",
    dueDate: row.dueDate ? normalizeDueDate(row.dueDate) : null,
    tags: row.tags
      ? row.tags
          .split(/[,;|]/)
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
    project: row.project && row.project.trim() ? row.project.trim() : "Inbox",
  };
}

// Todoist's real CSV export isn't a flat table of tasks — one file is a whole project, and each
// row's TYPE says what kind of row it is: "task" (an actual to-do), "section" (a header dividing
// the project, not a task itself), or "note" (a comment attached to the task above it). Feeding
// that straight through the generic aliaser above would silently import section headers and note
// text AS bogus tasks — CONTENT is the one column every row type happens to have, so csvRowToTask
// would happily accept all of them. INDENT (1 = top-level, 2+ = nested under the nearest
// shallower task) is Todoist's own sub-task nesting, mapped onto Haven's existing `subtasks`.
function isTodoistExport(headers) {
  return headers.includes("type") && headers.includes("content") && headers.includes("indent");
}

function parseTodoistCSV(rows, fieldMap) {
  const tasks = [];
  let currentSection = "Inbox";
  // Haven only supports one flat level of subtasks (no subtask-of-a-subtask), unlike Todoist's
  // arbitrary indent depth — every indent > 1 flattens onto the nearest top-level task's own
  // subtasks list, rather than attempting a nested tree Haven's data model has no room for.
  let currentTopLevelTask = null;

  for (let i = 1; i < rows.length; i++) {
    const raw = {};
    for (let col = 0; col < fieldMap.length; col++) {
      const field = fieldMap[col];
      if (field && rows[i][col] !== undefined) raw[field] = rows[i][col];
    }
    const typeCol = rows[i][fieldMap.indexOf("__type")];
    const indentCol = Number(rows[i][fieldMap.indexOf("__indent")]) || 1;
    const type = (typeCol || "task").trim().toLowerCase();

    if (type === "section") {
      currentSection = raw.title ? raw.title.trim() : currentSection;
      currentTopLevelTask = null;
      continue;
    }

    if (type === "note") {
      // Best-effort: attach to the current top-level task's own notes, since that's the only
      // place Haven's model has room for free text below task level — a note with nothing
      // above it (malformed export, or the very first row) has nowhere sensible to go.
      if (currentTopLevelTask && raw.title) {
        currentTopLevelTask.notes = currentTopLevelTask.notes
          ? `${currentTopLevelTask.notes}\n${raw.title.trim()}`
          : raw.title.trim();
      }
      continue;
    }

    // type === "task" (or unrecognized — treat as a task rather than silently dropping a row)
    const task = csvRowToTask(raw);
    if (!task) continue;

    if (indentCol > 1 && currentTopLevelTask) {
      currentTopLevelTask.subtasks.push({ id: cryptoRandomId(), title: task.title, done: task.status === "done" });
    } else {
      task.project = currentSection;
      task.subtasks = [];
      tasks.push(task);
      currentTopLevelTask = task;
    }
  }
  return tasks;
}

function cryptoRandomId() {
  return (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `sub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Full pipeline: raw CSV text -> array of partial task objects, using the
// first row as headers. Unknown columns are silently ignored rather than
// rejected — an export with extra app-specific columns (Todoist's AUTHOR,
// etc.) should still import what Haven does recognize.
export function parseCSVToTasks(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map(normalizeHeaderKey);
  const fieldMap = headers.map((h) => HEADER_ALIASES[h] || null);

  if (isTodoistExport(headers)) {
    // Keep TYPE/INDENT's raw column positions alongside the aliased field map, without polluting
    // HEADER_ALIASES with columns no other app's export uses this same way.
    const todoistFieldMap = headers.map((h) => {
      if (h === "type") return "__type";
      if (h === "indent") return "__indent";
      return HEADER_ALIASES[h] || null;
    });
    return parseTodoistCSV(rows, todoistFieldMap);
  }

  const tasks = [];
  for (let i = 1; i < rows.length; i++) {
    const raw = {};
    for (let col = 0; col < fieldMap.length; col++) {
      const field = fieldMap[col];
      if (field && rows[i][col] !== undefined) raw[field] = rows[i][col];
    }
    const task = csvRowToTask(raw);
    if (task) tasks.push(task);
  }
  return tasks;
}
