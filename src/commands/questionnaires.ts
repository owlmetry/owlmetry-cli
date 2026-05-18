import { Command, Option } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import type {
  QuestionnaireSpec,
  QuestionnaireResponseRecord,
  QuestionnaireResponseDetailResponse,
  QuestionnaireAnalyticsResponse,
  QuestionnaireSchema,
} from "../shared/index.js";
import { QUESTIONNAIRE_RESPONSE_STATUSES } from "../shared/index.js";
import { createClient } from "../config.js";
import { output, type OutputFormat } from "../formatters/index.js";
import { parsePositiveInt } from "../utils/parse.js";
import { paginationHint } from "../utils/pagination.js";

function statusBadge(status: string): string {
  switch (status) {
    case "new": return chalk.red("🆕 new");
    case "in_review": return chalk.blue("👀 in_review");
    case "addressed": return chalk.green("✅ addressed");
    case "dismissed": return chalk.gray("🚫 dismissed");
    default: return status;
  }
}

function loadSchema(filePath: string): QuestionnaireSchema {
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as QuestionnaireSchema;
}

function formatQuestionnaireTable(items: QuestionnaireSpec[]): string {
  if (items.length === 0) return chalk.dim("No questionnaires");
  const lines = [
    chalk.bold(
      "Slug".padEnd(28) +
      "Name".padEnd(28) +
      "Active".padEnd(10) +
      "Responses".padEnd(12) +
      "Last response",
    ),
    "─".repeat(110),
  ];
  for (const q of items) {
    const active = q.is_active ? chalk.green("✓ on") : chalk.gray("✗ off");
    const visLen = active.replace(/\x1b\[[0-9;]*m/g, "").length;
    const activePad = active + " ".repeat(Math.max(0, 10 - visLen));
    const last = q.last_response_at ? new Date(q.last_response_at).toLocaleString() : chalk.dim("—");
    lines.push(
      q.slug.slice(0, 26).padEnd(28) +
        q.name.slice(0, 26).padEnd(28) +
        activePad +
        String(q.response_count ?? 0).padEnd(12) +
        last,
    );
  }
  return lines.join("\n");
}

function formatQuestionnaireDetail(q: QuestionnaireSpec): string {
  const lines = [
    chalk.bold("Questionnaire"),
    "",
    `  ID:           ${q.id}`,
    `  Slug:         ${q.slug}`,
    `  Name:         ${q.name}`,
    `  Description:  ${q.description ?? chalk.dim("—")}`,
    `  Active:       ${q.is_active ? chalk.green("yes") : chalk.gray("no")}`,
    `  Responses:    ${q.response_count ?? 0}`,
    `  Last:         ${q.last_response_at ? new Date(q.last_response_at).toLocaleString() : chalk.dim("—")}`,
    "",
    chalk.bold("  Schema:"),
  ];
  for (const question of q.schema.questions) {
    const req = question.required ? chalk.red(" •") : "";
    let typeDetail = question.type;
    if (question.type === "single_choice" || question.type === "multi_choice") {
      typeDetail += ` (${question.options.length} options)`;
    } else if (question.type === "rating") {
      typeDetail += ` 1-${question.scale}`;
    } else if (question.type === "nps") {
      typeDetail += " 0-10";
    }
    lines.push(`    ${chalk.cyan(question.id.padEnd(14))} ${chalk.dim(typeDetail.padEnd(28))} ${question.title}${req}`);
  }
  return lines.join("\n");
}

function formatResponseTable(items: QuestionnaireResponseRecord[]): string {
  if (items.length === 0) return chalk.dim("No responses");
  const lines = [
    chalk.bold(
      "Status".padEnd(18) +
      "User".padEnd(22) +
      "When".padEnd(22) +
      "Sample answer",
    ),
    "─".repeat(110),
  ];
  for (const r of items) {
    const badge = statusBadge(r.status);
    const visLen = badge.replace(/\x1b\[[0-9;]*m/g, "").length;
    const badgePad = badge + " ".repeat(Math.max(0, 18 - visLen));
    const user = (r.user_id ?? chalk.dim("anonymous")).slice(0, 20);
    const userVisLen = user.replace(/\x1b\[[0-9;]*m/g, "").length;
    const userPad = user + " ".repeat(Math.max(0, 22 - userVisLen));
    const when = new Date(r.created_at).toLocaleString();
    const firstAnswer = Object.values(r.answers)[0];
    const sample = firstAnswer === undefined
      ? chalk.dim("—")
      : Array.isArray(firstAnswer)
        ? firstAnswer.join(", ")
        : String(firstAnswer);
    lines.push(`${badgePad}${userPad}${when.padEnd(22)}${sample.toString().slice(0, 40)}`);
  }
  return lines.join("\n");
}

function formatResponseDetail(r: QuestionnaireResponseDetailResponse): string {
  const lines = [
    chalk.bold("Response"),
    "",
    `  ID:           ${r.id}`,
    `  Status:       ${statusBadge(r.status)}`,
    `  Survey:       ${r.questionnaire_name ?? r.questionnaire_id} (${r.slug})`,
    `  App:          ${r.app_name ?? r.app_id}`,
    `  User:         ${r.user_id ?? chalk.dim("anonymous")}`,
    `  Session:      ${r.session_id ?? chalk.dim("—")}`,
    `  Version:      ${r.app_version ?? chalk.dim("—")}${r.environment ? `  (${r.environment})` : ""}`,
    `  Device:       ${r.device_model ?? chalk.dim("—")}${r.os_version ? `  OS ${r.os_version}` : ""}`,
    `  Country:      ${r.country_code ?? chalk.dim("—")}`,
    `  Dev:          ${r.is_dev ? "🛠️ yes" : "no"}`,
    `  Created:      ${new Date(r.created_at).toLocaleString()}`,
    "",
    chalk.bold("  Answers:"),
  ];
  for (const question of r.schema_snapshot.questions) {
    const answer = (r.answers as Record<string, unknown>)[question.id];
    let formatted: string;
    if (answer === undefined) {
      formatted = chalk.dim("(no answer)");
    } else if (question.type === "single_choice") {
      const opt = question.options.find((o) => o.id === answer);
      formatted = opt?.label ?? String(answer);
    } else if (question.type === "multi_choice" && Array.isArray(answer)) {
      formatted = answer
        .map((id) => question.options.find((o) => o.id === id)?.label ?? id)
        .join(", ");
    } else {
      formatted = String(answer);
    }
    lines.push(`    ${chalk.cyan(question.title)}`);
    lines.push(`      ${formatted}`);
  }
  if (r.comments.length > 0) {
    lines.push("", chalk.bold("  Comments:"));
    for (const c of r.comments) {
      const badge = c.author_type === "agent" ? "🕶️" : "👤";
      const ts = new Date(c.created_at).toLocaleString();
      lines.push(`    ${badge} ${c.author_name} (${ts}):`);
      lines.push(`      ${c.body}`);
    }
  }
  return lines.join("\n");
}

function formatAnalytics(a: QuestionnaireAnalyticsResponse): string {
  const lines = [
    chalk.bold("Analytics"),
    "",
    `  Slug:             ${a.slug}`,
    `  Total responses:  ${a.total_responses}`,
    "",
  ];
  for (const q of a.questions) {
    lines.push(chalk.bold(`  ${q.id} ${chalk.dim(`(${q.type})`)}`));
    lines.push(`    Answered: ${q.total_answered}`);
    if (q.type === "text") {
      if (q.recent_answers.length === 0) {
        lines.push(`    ${chalk.dim("No answers yet")}`);
      } else {
        for (const a of q.recent_answers.slice(0, 5)) {
          const snippet = a.answer.length > 80 ? a.answer.slice(0, 77) + "…" : a.answer;
          lines.push(`    • ${snippet}`);
        }
      }
    } else if (q.type === "single_choice" || q.type === "multi_choice") {
      for (const c of q.choices) {
        const pct = q.total_answered > 0 ? Math.round((c.count / q.total_answered) * 100) : 0;
        lines.push(`    ${c.label.padEnd(30)} ${String(c.count).padStart(4)}  (${pct}%)`);
      }
    } else if (q.type === "rating") {
      lines.push(`    Average: ${q.average ?? "—"}`);
      for (const b of q.buckets) {
        const pct = q.total_answered > 0 ? Math.round((b.count / q.total_answered) * 100) : 0;
        lines.push(`    ${"★".repeat(b.value).padEnd(8)} ${String(b.count).padStart(4)}  (${pct}%)`);
      }
    } else if (q.type === "nps") {
      lines.push(`    Score: ${q.score ?? "—"}`);
      lines.push(`    Detractors: ${q.detractors}  Passives: ${q.passives}  Promoters: ${q.promoters}`);
      for (const b of q.buckets) {
        const pct = q.total_answered > 0 ? Math.round((b.count / q.total_answered) * 100) : 0;
        lines.push(`    ${String(b.value).padStart(2)} ${String(b.count).padStart(4)}  (${pct}%)`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export const questionnairesCommand = new Command("questionnaires")
  .description("Manage in-app questionnaires (structured surveys)");

questionnairesCommand
  .command("list")
  .description("List questionnaires for a project")
  .requiredOption("--project-id <id>", "Project ID")
  .option("--app-id <id>", "Filter by app ID")
  .option("--active", "Show only active questionnaires")
  .option("--inactive", "Show only inactive questionnaires")
  .addOption(new Option("--limit <n>", "Max entries").argParser((v) => parsePositiveInt(v, "--limit")))
  .option("--cursor <cursor>", "Pagination cursor")
  .option("--format <format>", "Output format (table|json)", "table")
  .action(async (opts: {
    projectId: string;
    appId?: string;
    active?: boolean;
    inactive?: boolean;
    limit?: number;
    cursor?: string;
    format: OutputFormat;
  }) => {
    const client = await createClient();
    const params: Record<string, string> = {};
    if (opts.appId) params.app_id = opts.appId;
    if (opts.active) params.is_active = "true";
    if (opts.inactive) params.is_active = "false";
    if (opts.limit) params.limit = String(opts.limit);
    if (opts.cursor) params.cursor = opts.cursor;
    const res = await client.listQuestionnaires(opts.projectId, params);
    output(res, opts.format, () => {
      const out: string[] = [formatQuestionnaireTable(res.questionnaires)];
      const hint = paginationHint(res);
      if (hint) out.push("", hint);
      return out.join("\n");
    });
  });

questionnairesCommand
  .command("create")
  .description("Create a new questionnaire definition")
  .requiredOption("--project-id <id>", "Project ID")
  .requiredOption("--slug <slug>", "Slug (immutable, lowercase letters/digits/hyphens)")
  .requiredOption("--name <name>", "Human-readable name")
  .option("--description <text>", "Optional description")
  .option("--schema-file <path>", "Path to a JSON schema file")
  .option("--schema <json>", "Inline JSON schema (alternative to --schema-file)")
  .option("--app-id <id>", "Pin to a specific app (omit for project-wide)")
  .option("--inactive", "Create paused (default: active)")
  .option("--format <format>", "Output format", "json")
  .action(async (opts: {
    projectId: string;
    slug: string;
    name: string;
    description?: string;
    schemaFile?: string;
    schema?: string;
    appId?: string;
    inactive?: boolean;
    format: OutputFormat;
  }) => {
    if (!opts.schemaFile && !opts.schema) {
      throw new Error("Either --schema-file or --schema is required");
    }
    const schema = opts.schemaFile ? loadSchema(opts.schemaFile) : JSON.parse(opts.schema!);
    const client = await createClient();
    const created = await client.createQuestionnaire(opts.projectId, {
      slug: opts.slug,
      name: opts.name,
      description: opts.description ?? null,
      schema,
      app_id: opts.appId ?? null,
      is_active: !opts.inactive,
    });
    output(created, opts.format, () => formatQuestionnaireDetail(created));
  });

questionnairesCommand
  .command("view <id>")
  .description("Show questionnaire detail")
  .requiredOption("--project-id <id>", "Project ID")
  .option("--format <format>", "Output format", "table")
  .action(async (id: string, opts: { projectId: string; format: OutputFormat }) => {
    const client = await createClient();
    const q = await client.getQuestionnaire(opts.projectId, id);
    output(q, opts.format, () => formatQuestionnaireDetail(q));
  });

questionnairesCommand
  .command("update <id>")
  .description("Update questionnaire fields (slug is immutable)")
  .requiredOption("--project-id <id>", "Project ID")
  .option("--name <name>", "New name")
  .option("--description <text>", "New description (pass empty string to clear)")
  .option("--schema-file <path>", "Path to a new JSON schema file")
  .option("--schema <json>", "Inline JSON schema")
  .option("--active <bool>", "Set is_active (true|false)")
  .option("--app-id <id>", "Pin to a specific app (use 'null' to unpin)")
  .option("--format <format>", "Output format", "table")
  .action(async (id: string, opts: {
    projectId: string;
    name?: string;
    description?: string;
    schemaFile?: string;
    schema?: string;
    active?: string;
    appId?: string;
    format: OutputFormat;
  }) => {
    const patch: Record<string, unknown> = {};
    if (opts.name) patch.name = opts.name;
    if (opts.description !== undefined) patch.description = opts.description.length === 0 ? null : opts.description;
    if (opts.schemaFile) patch.schema = loadSchema(opts.schemaFile);
    else if (opts.schema) patch.schema = JSON.parse(opts.schema);
    if (opts.active !== undefined) patch.is_active = opts.active.toLowerCase() === "true";
    if (opts.appId !== undefined) patch.app_id = opts.appId === "null" ? null : opts.appId;
    if (Object.keys(patch).length === 0) {
      throw new Error("Nothing to update — pass at least one of --name / --description / --schema(-file) / --active / --app-id");
    }
    const client = await createClient();
    const updated = await client.updateQuestionnaire(opts.projectId, id, patch);
    output(updated, opts.format, () => formatQuestionnaireDetail(updated));
  });

questionnairesCommand
  .command("delete <id>")
  .description("Soft-delete a questionnaire (user-only; agent keys get 403)")
  .requiredOption("--project-id <id>", "Project ID")
  .option("--format <format>", "Output format", "json")
  .action(async (id: string, opts: { projectId: string; format: OutputFormat }) => {
    const client = await createClient();
    const res = await client.deleteQuestionnaire(opts.projectId, id);
    output(res, opts.format, () => chalk.green("✓ deleted"));
  });

questionnairesCommand
  .command("responses <questionnaireId>")
  .description("List responses to a questionnaire")
  .requiredOption("--project-id <id>", "Project ID")
  .addOption(new Option("--status <s>", "Filter by status").choices([...QUESTIONNAIRE_RESPONSE_STATUSES]))
  .option("--app-id <id>", "Filter by app ID")
  .option("--dev", "Show dev responses only")
  .addOption(new Option("--data-mode <m>", "Data mode (production|development|all)"))
  .addOption(new Option("--limit <n>", "Max entries").argParser((v) => parsePositiveInt(v, "--limit")))
  .option("--cursor <cursor>", "Pagination cursor")
  .option("--format <format>", "Output format", "table")
  .action(async (questionnaireId: string, opts: {
    projectId: string;
    status?: string;
    appId?: string;
    dev?: boolean;
    dataMode?: string;
    limit?: number;
    cursor?: string;
    format: OutputFormat;
  }) => {
    const client = await createClient();
    const params: Record<string, string> = {};
    if (opts.status) params.status = opts.status;
    if (opts.appId) params.app_id = opts.appId;
    if (opts.dev) params.is_dev = "true";
    if (opts.dataMode) params.data_mode = opts.dataMode;
    if (opts.limit) params.limit = String(opts.limit);
    if (opts.cursor) params.cursor = opts.cursor;
    const res = await client.listQuestionnaireResponses(opts.projectId, questionnaireId, params);
    output(res, opts.format, () => {
      const out: string[] = [formatResponseTable(res.responses)];
      const hint = paginationHint(res);
      if (hint) out.push("", hint);
      return out.join("\n");
    });
  });

questionnairesCommand
  .command("response <responseId>")
  .description("Show a single response with comments")
  .requiredOption("--project-id <id>", "Project ID")
  .requiredOption("--questionnaire <id>", "Questionnaire ID")
  .option("--format <format>", "Output format", "table")
  .action(async (responseId: string, opts: { projectId: string; questionnaire: string; format: OutputFormat }) => {
    const client = await createClient();
    const r = await client.getQuestionnaireResponse(opts.projectId, opts.questionnaire, responseId);
    output(r, opts.format, () => formatResponseDetail(r));
  });

questionnairesCommand
  .command("status <responseId>")
  .description("Transition response status")
  .requiredOption("--project-id <id>", "Project ID")
  .requiredOption("--questionnaire <id>", "Questionnaire ID")
  .addOption(new Option("--to <status>", "Target status").choices([...QUESTIONNAIRE_RESPONSE_STATUSES]).makeOptionMandatory(true))
  .option("--format <format>", "Output format", "json")
  .action(async (responseId: string, opts: { projectId: string; questionnaire: string; to: string; format: OutputFormat }) => {
    const client = await createClient();
    const r = await client.updateQuestionnaireResponseStatus(
      opts.projectId,
      opts.questionnaire,
      responseId,
      { status: opts.to as any },
    );
    output(r, opts.format, () => `Status: ${statusBadge(r.status)}`);
  });

questionnairesCommand
  .command("comment <responseId>")
  .description("Add a comment to a response")
  .requiredOption("--project-id <id>", "Project ID")
  .requiredOption("--questionnaire <id>", "Questionnaire ID")
  .requiredOption("--body <text>", "Comment body (markdown supported)")
  .option("--format <format>", "Output format", "json")
  .action(async (responseId: string, opts: { projectId: string; questionnaire: string; body: string; format: OutputFormat }) => {
    const client = await createClient();
    const c = await client.addQuestionnaireResponseComment(
      opts.projectId,
      opts.questionnaire,
      responseId,
      { body: opts.body },
    );
    output(c, opts.format, () => chalk.green(`✓ comment added by ${c.author_name}`));
  });

questionnairesCommand
  .command("analytics <questionnaireId>")
  .description("Pre-aggregated per-question analytics")
  .requiredOption("--project-id <id>", "Project ID")
  .option("--dev", "Show dev responses only")
  .addOption(new Option("--data-mode <m>", "Data mode (production|development|all)"))
  .option("--format <format>", "Output format", "table")
  .action(async (questionnaireId: string, opts: { projectId: string; dev?: boolean; dataMode?: string; format: OutputFormat }) => {
    const client = await createClient();
    const a = await client.getQuestionnaireAnalytics(opts.projectId, questionnaireId, {
      is_dev: opts.dev ? true : undefined,
      data_mode: opts.dataMode,
    });
    output(a, opts.format, () => formatAnalytics(a));
  });
