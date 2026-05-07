import { Command, Option } from "commander";
import chalk from "chalk";
import {
  ADS_ATTRIBUTION_SOURCES,
  classifyAdStatus,
  formatRoasLabel,
  roasTone,
  type AdsRow,
  type RoasTone,
  type TeamAdsRow,
} from "../shared/index.js";
import { createClient } from "../config.js";
import { output, type OutputFormat } from "../formatters/index.js";

const SOURCE_CHOICES: string[] = [...ADS_ATTRIBUTION_SOURCES];

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return "$0.00";
  return usdFormatter.format(amount);
}

function formatSpend(spend: number | null): string {
  return spend == null ? chalk.dim("—") : formatUsd(spend);
}

const ROAS_CHALK: Record<RoasTone, (s: string) => string> = {
  good: chalk.green,
  warn: chalk.yellow,
  bad: chalk.red,
  muted: chalk.dim,
};

function formatRoas(roas: number | null): string {
  return ROAS_CHALK[roasTone(roas)](formatRoasLabel(roas));
}

function windowDaysLabel(days: number | null | undefined): string | null {
  if (!days) return null;
  if (days % 30 === 0 && days >= 60) return `Last ${days / 30} months`;
  if (days % 7 === 0 && days < 90) return `Last ${days / 7} weeks`;
  return `Last ${days} days`;
}

function statusBadge(status: string | null): string {
  const c = classifyAdStatus(status);
  if (!c) return "";
  if (c.tone === "warn") return chalk.yellow(` [${c.label.toLowerCase()}]`);
  if (c.tone === "bad") return chalk.red(` [${c.label.toLowerCase()}]`);
  return chalk.dim(` [${c.label}]`);
}

// `formatRoas` returns chalk-styled text — those ANSI escapes are zero-width
// visually but inflate `.length`, so we pad on the unstyled width and append
// the styled value. Same trick for the status badge.
function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}
function padLeftStyled(visible: string, styled: string, width: number): string {
  const pad = Math.max(width - visible.length, 0);
  return " ".repeat(pad) + styled;
}

function nameCell(row: AdsRow, width: number): string {
  const display = (row.name ?? row.id).slice(0, width);
  const badge = statusBadge(row.status);
  // Pad to (width + 1) so badge sits one space off the name, regardless of length.
  return padRight(display, width) + badge;
}

function renderTable(rows: AdsRow[], nameHeader: string): string {
  if (rows.length === 0) return chalk.dim("  No data");
  const showSpend = rows.some((r) => r.total_spend_usd != null);
  const lines: string[] = [];
  // "Conv." abbreviates "Conversions" (paid_user_count) so the column stays in
  // the existing 8-char width; "Retained" gets padStart(10) for a visual gap
  // from the previous column. Full names appear in --json output.
  const header =
    nameHeader.padEnd(40) +
    "Users".padStart(8) +
    "Conv.".padStart(8) +
    "Retained".padStart(10) +
    "Revenue".padStart(14) +
    "ARPU".padStart(10) +
    (showSpend ? "Spend".padStart(12) + "ROAS".padStart(8) : "");
  lines.push(chalk.bold(header));
  lines.push("─".repeat(header.length));
  for (const r of rows) {
    let line =
      nameCell(r, 32).padEnd(40) +
      r.user_count.toLocaleString().padStart(8) +
      r.paid_user_count.toLocaleString().padStart(8) +
      r.retained_user_count.toLocaleString().padStart(10) +
      formatUsd(r.total_revenue_usd).padStart(14) +
      formatUsd(r.arpu).padStart(10);
    if (showSpend) {
      line += formatSpend(r.total_spend_usd).padStart(12);
      line += padLeftStyled(formatRoasLabel(r.roas), formatRoas(r.roas), 8);
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function renderTeamTable(rows: TeamAdsRow[]): string {
  if (rows.length === 0) return chalk.dim("  No data");
  const showSpend = rows.some((r) => r.total_spend_usd != null);
  const lines: string[] = [];
  const header =
    "Project".padEnd(20) +
    "Campaign".padEnd(36) +
    "Users".padStart(8) +
    "Conv.".padStart(8) +
    "Retained".padStart(10) +
    "Revenue".padStart(14) +
    "ARPU".padStart(10) +
    (showSpend ? "Spend".padStart(12) + "ROAS".padStart(8) : "");
  lines.push(chalk.bold(header));
  lines.push("─".repeat(header.length));
  for (const r of rows) {
    const project = (r.project_id ?? "").slice(0, 20);
    let line =
      project.padEnd(20) +
      nameCell(r, 28).padEnd(36) +
      r.user_count.toLocaleString().padStart(8) +
      r.paid_user_count.toLocaleString().padStart(8) +
      r.retained_user_count.toLocaleString().padStart(10) +
      formatUsd(r.total_revenue_usd).padStart(14) +
      formatUsd(r.arpu).padStart(10);
    if (showSpend) {
      line += formatSpend(r.total_spend_usd).padStart(12);
      line += padLeftStyled(formatRoasLabel(r.roas), formatRoas(r.roas), 8);
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export const adsCommand = new Command("ads")
  .description("Advertising insights — campaigns ranked by USD revenue. Spend + revenue both scoped to the same trailing 12-month window so ROAS stays comparable.");

adsCommand
  .command("campaigns")
  .description(
    "List campaigns ranked by USD revenue. Spend + revenue both scoped to the same trailing 12-month window. Pass --team-id to aggregate across every project in a team (the dashboard's 'All projects' view).",
  )
  .option("--project-id <id>", "Project ID (single-project view)")
  .option(
    "--team-id <id>",
    "Team ID — aggregates across every project in the team. Mutually exclusive with --project-id.",
  )
  .option("--app-id <id>", "Scope to a single app (only with --project-id)")
  .addOption(
    new Option("--source <source>", "Attribution network").choices(SOURCE_CHOICES).default("apple_search_ads"),
  )
  .option("--limit <n>", "Max rows", (v) => Number(v))
  .action(
    async (
      opts: {
        projectId?: string;
        teamId?: string;
        appId?: string;
        source?: string;
        limit?: number;
      },
      cmd,
    ) => {
      if (!opts.projectId && !opts.teamId) {
        cmd.error("error: required option '--project-id <id>' or '--team-id <id>' not specified");
      }
      if (opts.projectId && opts.teamId) {
        cmd.error("error: --project-id and --team-id are mutually exclusive");
      }
      const { client, globals } = createClient(cmd);

      if (opts.teamId) {
        const result = await client.listAdCampaignsAcrossTeam(opts.teamId, {
          attribution_source: opts.source,
          limit: opts.limit,
        });
        output(globals.format as OutputFormat, result, () => {
          const lines = [
            chalk.bold(`${opts.source} · all projects`),
            chalk.dim(
              `  ${result.total_user_count.toLocaleString()} attributed users · ` +
                `${result.total_paid_user_count.toLocaleString()} conversions · ` +
                `${result.total_retained_user_count.toLocaleString()} retained · ` +
                formatUsd(result.total_revenue_usd) + " lifetime revenue" +
                (result.total_spend_usd != null
                  ? ` · ${formatUsd(result.total_spend_usd)} spend (ROAS ${formatRoas(result.total_spend_usd > 0 ? result.total_revenue_usd / result.total_spend_usd : null)})`
                  : ""),
            ),
          ];
          if (result.currency_warning) {
            lines.push(chalk.yellow(`  ⚠ Spend reported in ${result.currency_warning}; ROAS unavailable.`));
          }
          if (result.revenue_synced_at) {
            lines.push(chalk.dim(`  Revenue synced: ${new Date(result.revenue_synced_at).toLocaleString()}`));
          }
          if (result.ad_metrics_synced_at) {
            lines.push(chalk.dim(`  Spend synced: ${new Date(result.ad_metrics_synced_at).toLocaleString()}`));
          }
          lines.push("", chalk.bold("Campaigns"), renderTeamTable(result.campaigns));
          return lines.join("\n");
        });
        return;
      }

      const result = await client.listAdCampaigns(opts.projectId!, {
        attribution_source: opts.source,
        app_id: opts.appId,
        limit: opts.limit,
      });
      output(globals.format as OutputFormat, result, () => {
        const lines = [
          chalk.bold(`${opts.source}`),
          chalk.dim(
            `  ${result.total_user_count.toLocaleString()} attributed users · ` +
              `${result.total_paid_user_count.toLocaleString()} conversions · ` +
              `${result.total_retained_user_count.toLocaleString()} retained · ` +
              formatUsd(result.total_revenue_usd) + " lifetime revenue" +
              (result.total_spend_usd != null
                ? ` · ${formatUsd(result.total_spend_usd)} spend (ROAS ${formatRoas(result.total_spend_usd > 0 ? result.total_revenue_usd / result.total_spend_usd : null)})`
                : ""),
          ),
        ];
        const windowLabel = windowDaysLabel(result.window_days);
        if (windowLabel) {
          lines.push(chalk.dim(`  Window: ${windowLabel} (spend + revenue scoped to same trailing window)`));
        }
        if (result.currency_warning) {
          lines.push(chalk.yellow(`  ⚠ Spend reported in ${result.currency_warning}; ROAS unavailable.`));
        }
        if (result.revenue_synced_at) {
          lines.push(chalk.dim(`  Revenue synced: ${new Date(result.revenue_synced_at).toLocaleString()}`));
        }
        if (result.ad_metrics_synced_at) {
          lines.push(chalk.dim(`  Spend synced: ${new Date(result.ad_metrics_synced_at).toLocaleString()}`));
        }
        lines.push("", chalk.bold("Campaigns"), renderTable(result.campaigns, "Campaign"));
        return lines.join("\n");
      });
    },
  );

adsCommand
  .command("ad-groups <campaignId>")
  .description("List ad groups within a campaign, ranked by revenue")
  .requiredOption("--project-id <id>", "Project ID")
  .option("--app-id <id>", "Scope to a single app")
  .addOption(
    new Option("--source <source>", "Attribution network").choices(SOURCE_CHOICES).default("apple_search_ads"),
  )
  .option("--limit <n>", "Max rows", (v) => Number(v))
  .action(
    async (
      campaignId: string,
      opts: { projectId: string; appId?: string; source?: string; limit?: number },
      cmd,
    ) => {
      const { client, globals } = createClient(cmd);
      const result = await client.listAdGroups(opts.projectId, campaignId, {
        attribution_source: opts.source,
        app_id: opts.appId,
        limit: opts.limit,
      });
      output(globals.format as OutputFormat, result, () => {
        const lines = [chalk.bold(result.campaign_name ?? campaignId)];
        const windowLabel = windowDaysLabel(result.window_days);
        if (windowLabel) {
          lines.push(chalk.dim(`  ${windowLabel}`));
        }
        lines.push("", chalk.bold("Ad groups"), renderTable(result.ad_groups, "Ad group"));
        return lines.join("\n");
      });
    },
  );

adsCommand
  .command("leaves <adGroupId>")
  .description("List keywords + ads within an ad group, ranked by revenue")
  .requiredOption("--project-id <id>", "Project ID")
  .requiredOption("--campaign-id <id>", "Parent campaign ID")
  .option("--app-id <id>", "Scope to a single app")
  .addOption(
    new Option("--source <source>", "Attribution network").choices(SOURCE_CHOICES).default("apple_search_ads"),
  )
  .option("--limit <n>", "Max rows", (v) => Number(v))
  .action(
    async (
      adGroupId: string,
      opts: {
        projectId: string;
        campaignId: string;
        appId?: string;
        source?: string;
        limit?: number;
      },
      cmd,
    ) => {
      const { client, globals } = createClient(cmd);
      const result = await client.listAdLeaves(opts.projectId, opts.campaignId, adGroupId, {
        attribution_source: opts.source,
        app_id: opts.appId,
        limit: opts.limit,
      });
      output(globals.format as OutputFormat, result, () => {
        const lines = [
          chalk.bold(`${result.campaign_name ?? opts.campaignId} → ${result.ad_group_name ?? adGroupId}`),
        ];
        const windowLabel = windowDaysLabel(result.window_days);
        if (windowLabel) {
          lines.push(chalk.dim(`  ${windowLabel}`));
        }
        lines.push(
          "",
          chalk.bold("Keywords"),
          renderTable(result.keywords, "Keyword"),
          "",
          chalk.bold("Ads"),
          renderTable(result.ads, "Ad"),
        );
        return lines.join("\n");
      });
    },
  );

adsCommand
  .command("sync")
  .description("Trigger a manual sync (refreshes revenue + Apple Ads names) (admin only)")
  .requiredOption("--project-id <id>", "Project ID")
  .action(async (opts: { projectId: string }, cmd) => {
    const { client, globals } = createClient(cmd);
    const result = await client.syncAds(opts.projectId);
    output(globals.format as OutputFormat, result, () =>
      chalk.green(
        `Sync queued. revenuecat_sync: ${result.revenuecat_job_run_id} · apple_ads_sync: ${result.apple_ads_job_run_id}`,
      ),
    );
  });
