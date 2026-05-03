import chalk from "chalk";
import { compareToLatest } from "../shared/version.js";

export function formatVersion(
  version: string | null | undefined,
  latest: string | null | undefined,
): string {
  if (!version) return "";
  const cmp = compareToLatest(version, latest ?? null);
  if (cmp === null) return version;
  // Older than latest → yellow. Equal or newer (e.g. TestFlight ahead of App
  // Store, or hourly app_version_sync hasn't picked up the new release yet) → green.
  if (cmp < 0) return chalk.yellow(version);
  return chalk.green(version);
}

/** Renders an SDK identity pair as `"<name> <version>"`, or an empty string
 * if both inputs are missing. Callers handle the empty case (typically as `"—"`). */
export function formatSdkLabel(
  name: string | null | undefined,
  version: string | null | undefined,
): string {
  return [name, version].filter(Boolean).join(" ");
}
