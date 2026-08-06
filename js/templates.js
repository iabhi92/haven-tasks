// Static starter task sets — pure data, no IO. Applying one just calls the
// app's normal addTask() once per task, so a template-created task is
// completely indistinguishable from a hand-typed one afterward (same
// encryption, same history-log entry, same automation-rule triggers).
// See docs/ARCHITECTURE.md "Board / project templates".

export const TEMPLATES = [
  {
    id: "sprint-board",
    name: "Sprint board",
    description: "A two-week sprint, from planning to retro.",
    tasks: [
      { title: "Plan sprint goals", priority: "high" },
      { title: "Write user stories", priority: "medium" },
      { title: "Daily standup", priority: "low", recurrence: "daily" },
      { title: "Clear code review backlog", priority: "medium" },
      { title: "Deploy to staging", priority: "high" },
      { title: "Sprint demo", priority: "medium" },
      { title: "Retro — what worked, what didn't", priority: "low" },
    ],
  },
  {
    id: "client-onboarding",
    name: "Client onboarding",
    description: "First-week checklist for a new client.",
    tasks: [
      { title: "Send welcome email", priority: "high" },
      { title: "Schedule kickoff call", priority: "high" },
      { title: "Collect requirements document", priority: "medium" },
      { title: "Set up shared folder", priority: "medium" },
      { title: "Send contract and invoice", priority: "high" },
      { title: "Add to weekly check-in schedule", priority: "low", recurrence: "weekly" },
    ],
  },
  {
    id: "moving-house",
    name: "Moving house",
    description: "The unglamorous checklist nobody remembers in full.",
    tasks: [
      { title: "Book moving company or van", priority: "high" },
      { title: "Change address — bank", priority: "medium" },
      { title: "Change address — post/mail forwarding", priority: "medium" },
      { title: "Notify utilities (electric, gas, internet)", priority: "high" },
      { title: "Pack non-essentials", priority: "low" },
      { title: "Clean old place", priority: "medium" },
      { title: "Update address on ID/licenses", priority: "low" },
    ],
  },
  {
    id: "weekly-review",
    name: "Weekly review",
    description: "A recurring reset, GTD-style.",
    tasks: [
      { title: "Review last week's completed tasks", priority: "low", recurrence: "weekly" },
      { title: "Plan this week's top 3 priorities", priority: "high", recurrence: "weekly" },
      { title: "Clear inbox to zero", priority: "medium", recurrence: "weekly" },
      { title: "Review upcoming due dates", priority: "medium", recurrence: "weekly" },
      { title: "Follow up on open emails", priority: "low", recurrence: "weekly" },
    ],
  },
  {
    id: "freelance-kickoff",
    name: "Freelance project kickoff",
    description: "From proposal to first invoice.",
    tasks: [
      { title: "Send proposal", priority: "high" },
      { title: "Sign contract", priority: "high" },
      { title: "Invoice deposit", priority: "medium" },
      { title: "Set up project folder and files", priority: "low" },
      { title: "Schedule check-in calls", priority: "medium", recurrence: "weekly" },
      { title: "Send final invoice", priority: "high" },
    ],
  },
];

export function findTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}
