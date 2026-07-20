#!/usr/bin/env node
// Daily task digest — meant to run on a schedule (cron, 9:00 AM) on the VPS,
// NOT as an MCP tool Claude calls. It pulls every open (non-DONE) task from
// Twenty CRM, groups them by assignee, and emails each human team member
// their own list via Gmail SMTP.
//
// Tasks assigned to the "Claude" bot member (CLAUDE_ASSIGNEE_ID) are
// excluded from the human digest — those are Claude's queue, not a person's.
//
// Usage:
//   node daily-digest.js          # sends real emails
//   node daily-digest.js --dry-run  # prints what would be sent, sends nothing

import nodemailer from "nodemailer";

const TWENTY_API_KEY = process.env.TWENTY_API_KEY;
const TWENTY_BASE_URL = process.env.TWENTY_BASE_URL || "https://api.twenty.com";
const CLAUDE_ASSIGNEE_ID = process.env.CLAUDE_ASSIGNEE_ID || null;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const DRY_RUN = process.argv.includes("--dry-run");

if (!TWENTY_API_KEY) {
  console.error("TWENTY_API_KEY is required.");
  process.exit(1);
}
if (!DRY_RUN && (!GMAIL_USER || !GMAIL_APP_PASSWORD)) {
  console.error("GMAIL_USER and GMAIL_APP_PASSWORD are required (or pass --dry-run).");
  process.exit(1);
}

async function twentyRequest(endpoint) {
  const res = await fetch(`${TWENTY_BASE_URL}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${TWENTY_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${endpoint}: ${await res.text()}`);
  }
  return res.json();
}

// Paginate through a Twenty REST collection endpoint, returning all records.
async function fetchAll(basePath, pageSize = 60) {
  let offset = 0;
  const all = [];
  while (true) {
    const page = await twentyRequest(`${basePath}&limit=${pageSize}&offset=${offset}`);
    const records = page?.data?.[Object.keys(page.data || {})[0]] || page?.records || page?.data || [];
    const items = Array.isArray(records) ? records : [];
    all.push(...items);
    if (items.length < pageSize) break;
    offset += pageSize;
    if (offset > 5000) break; // safety valve
  }
  return all;
}

function memberEmail(member) {
  return member.userEmail || member.email || member.workEmail || null;
}

function memberName(member) {
  const first = member.name?.firstName || member.firstName || "";
  const last = member.name?.lastName || member.lastName || "";
  const full = `${first} ${last}`.trim();
  return full || member.userEmail || member.email || "Unknown";
}

function formatTask(task) {
  const due = task.dueAt ? new Date(task.dueAt).toLocaleDateString() : "No due date";
  const status = task.status || "TODO";
  return `- [${status}] ${task.title} (due: ${due})`;
}

function digestHtml(name, tasks) {
  const rows = tasks
    .map((t) => {
      const due = t.dueAt ? new Date(t.dueAt).toLocaleDateString() : "No due date";
      return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${t.title}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee;">${t.status || "TODO"}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee;">${due}</td></tr>`;
    })
    .join("\n");
  return `
    <p>Hi ${name},</p>
    <p>You have <strong>${tasks.length}</strong> open task${tasks.length === 1 ? "" : "s"} in Twenty CRM:</p>
    <table style="border-collapse:collapse;width:100%;max-width:600px;">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #333;">Title</th>
          <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #333;">Status</th>
          <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #333;">Due</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#777;font-size:12px;">Automated daily digest from your Twenty CRM MCP integration.</p>
  `;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Running daily task digest${DRY_RUN ? " (dry run)" : ""}...`);

  const [tasks, members] = await Promise.all([
    fetchAll("/rest/tasks?"),
    fetchAll("/rest/workspaceMembers?"),
  ]);

  const memberById = new Map(members.map((m) => [m.id, m]));

  const openTasks = tasks.filter((t) => t.status !== "DONE");
  const byAssignee = new Map();

  for (const task of openTasks) {
    const assigneeId = task.assigneeId;
    if (!assigneeId) continue; // unassigned — skip
    if (CLAUDE_ASSIGNEE_ID && assigneeId === CLAUDE_ASSIGNEE_ID) continue; // Claude's queue, not a human's

    if (!byAssignee.has(assigneeId)) byAssignee.set(assigneeId, []);
    byAssignee.get(assigneeId).push(task);
  }

  let transporter = null;
  if (!DRY_RUN) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }

  let sent = 0;
  for (const [assigneeId, memberTasks] of byAssignee.entries()) {
    const member = memberById.get(assigneeId);
    if (!member) {
      console.warn(`No workspace member found for assigneeId ${assigneeId}, skipping.`);
      continue;
    }
    const email = memberEmail(member);
    const name = memberName(member);
    if (!email) {
      console.warn(`No email on file for ${name} (${assigneeId}), skipping.`);
      continue;
    }

    console.log(`\n${name} <${email}> — ${memberTasks.length} open task(s):`);
    memberTasks.forEach((t) => console.log("  " + formatTask(t)));

    if (!DRY_RUN) {
      await transporter.sendMail({
        from: GMAIL_USER,
        to: email,
        subject: `Your daily task digest — ${memberTasks.length} open task${memberTasks.length === 1 ? "" : "s"}`,
        html: digestHtml(name, memberTasks),
      });
      sent += 1;
    }
  }

  console.log(`\nDone. ${DRY_RUN ? "Dry run — no emails sent." : `${sent} digest email(s) sent.`}`);
}

main().catch((error) => {
  console.error("Digest run failed:", error);
  process.exit(1);
});
