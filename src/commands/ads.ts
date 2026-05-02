import { Command, Option } from "commander";
import chalk from "chalk";
import { ADS_ATTRIBUTION_SOURCES, type AdsRow } from "../shared/index.js";
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

function renderTable(rows: AdsRow[], nameHeader: string): string {
  if (rows.length === 0) return chalk.dim("  No data");
  const lines: string[] = [];
  lines.push(
    chalk.bold(
      nameHeader.padEnd(32) +
        "Users".padStart(8) +
        "Paying".padStart(8) +
        "Revenue".padStart(14) +
        "ARPU".padStart(10),
    ),
  );
  lines.push("─".repeat(72));
  for (const r of rows) {
    const name = (r.name ?? r.id).slice(0, 32);
    lines.push(
      name.padEnd(32) +
        r.user_count.toLocaleString().padStart(8) +
        r.paying_user_count.toLocaleString().padStart(8) +
        formatUsd(r.total_revenue_usd).padStart(14) +
        formatUsd(r.arpu).padStart(10),
    );
  }
  return lines.join("\n");
}

export const adsCommand = new Command("ads")
  .description("Advertising insights — campaigns ranked by lifetime revenue");

adsCommand
  .command("campaigns")
  .description("List campaigns ranked by lifetime USD revenue")
  .requiredOption("--project-id <id>", "Project ID")
  .option("--app-id <id>", "Scope to a single app")
  .addOption(
    new Option("--source <source>", "Attribution network").choices(SOURCE_CHOICES).default("apple_search_ads"),
  )
  .option("--limit <n>", "Max rows", (v) => Number(v))
  .action(
    async (
      opts: { projectId: string; appId?: string; source?: string; limit?: number },
      cmd,
    ) => {
      const { client, globals } = createClient(cmd);
      const result = await client.listAdCampaigns(opts.projectId, {
        attribution_source: opts.source,
        app_id: opts.appId,
        limit: opts.limit,
      });
      output(globals.format as OutputFormat, result, () => {
        const lines = [
          chalk.bold(`${opts.source}`),
          chalk.dim(
            `  ${result.total_user_count.toLocaleString()} attributed users · ` +
              `${result.total_paying_user_count.toLocaleString()} paying · ` +
              formatUsd(result.total_revenue_usd) + " lifetime",
          ),
        ];
        if (result.revenue_synced_at) {
          lines.push(
            chalk.dim(`  Revenue last synced: ${new Date(result.revenue_synced_at).toLocaleString()}`),
          );
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
        const lines = [
          chalk.bold(result.campaign_name ?? campaignId),
          "",
          chalk.bold("Ad groups"),
          renderTable(result.ad_groups, "Ad group"),
        ];
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
          "",
          chalk.bold("Keywords"),
          renderTable(result.keywords, "Keyword"),
          "",
          chalk.bold("Ads"),
          renderTable(result.ads, "Ad"),
        ];
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
