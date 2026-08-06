// Pure iCalendar (RFC 5545) generation — no IO, takes the already-decrypted
// task list and returns .ics text. One-way export only (Haven -> your
// calendar app), not a live two-way CalDAV sync — see docs/ARCHITECTURE.md
// "Calendar export" for why that's the honest scope for this feature.

// RFC 5545 §3.3.11: backslash, semicolon, comma, and newline all need
// escaping inside TEXT values — a title/notes containing any of these would
// otherwise produce a malformed .ics file that some calendar apps reject
// outright rather than degrade gracefully.
function escapeICSText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

// "YYYY-MM-DD" -> "YYYYMMDD", the DATE (not DATE-TIME) form RFC 5545 uses
// for all-day events — Haven's due dates never carry a time-of-day, so
// every event this produces is genuinely all-day, not midnight-on-a-clock.
function toICSDate(isoDate) {
  return isoDate.replace(/-/g, "");
}

function toICSTimestamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

// Folds a line at 75 octets per RFC 5545 §3.1 — most calendar apps tolerate
// unfolded lines, but a couple (notably some older Outlook versions) will
// silently truncate a long SUMMARY/DESCRIPTION without it.
function foldLine(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let rest = line;
  while (rest.length > 75) {
    parts.push(rest.slice(0, 75));
    rest = " " + rest.slice(75);
  }
  parts.push(rest);
  return parts.join("\r\n");
}

export function generateICS(tasks) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Haven//Task Export//EN", "CALSCALE:GREGORIAN"];

  for (const task of tasks) {
    if (task.destructed || !task.dueDate) continue;
    lines.push("BEGIN:VEVENT");
    lines.push(foldLine(`UID:${task.id}@taskhavens.com`));
    lines.push(`DTSTAMP:${toICSTimestamp(task.updatedAt || Date.now())}`);
    lines.push(`DTSTART;VALUE=DATE:${toICSDate(task.dueDate)}`);
    lines.push(foldLine(`SUMMARY:${escapeICSText(task.title)}`));
    if (task.notes) lines.push(foldLine(`DESCRIPTION:${escapeICSText(task.notes)}`));
    lines.push(`STATUS:${task.status === "done" ? "COMPLETED" : "NEEDS-ACTION"}`);
    if (task.priority === "high") lines.push("PRIORITY:1");
    else if (task.priority === "medium") lines.push("PRIORITY:5");
    else lines.push("PRIORITY:9");
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
