// Getting the user's attention when a job is waiting for their Approve click: a system notification, and the Flow
// Studio page opened for them if no Studio page is showing. Best effort throughout: none of this may ever stop a job.
import { execFile } from "node:child_process";
import { openUrl } from "./platform.js";

const PORT = Number(process.env.FLOW_MCP_PORT ?? 8787);
export const STUDIO_URL = `http://127.0.0.1:${PORT}`;

// An open Studio page asks for the status every few seconds and marks its requests, so "seen lately" means the
// page is open somewhere.
let lastSeen = 0;
export const studioSeen = (): void => void (lastSeen = Date.now());
export const studioOpen = (): boolean => Date.now() - lastSeen < 30_000;

function notify(title: string, body: string): void {
  const quiet = () => undefined;
  try {
    if (process.platform === "darwin") {
      // Passed as arguments to the script, never pasted into it, so no text can break out of the quotes.
      const script = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"\nend run';
      execFile("osascript", ["-e", script, title, body], quiet).on("error", quiet);
    } else if (process.platform === "linux") {
      execFile("notify-send", [title, body], quiet).on("error", quiet);
    }
  } catch {
    // A notification is a courtesy.
  }
}

let pending: NodeJS.Timeout | undefined;
let waiting = { jobs: 0, credits: 0, where: "" };

// Several scenes queued in one call ask once, with the total.
export function askForApproval(credits: number, where: string): void {
  if (process.env.FLOW_MCP_QUIET) return;
  waiting = { jobs: waiting.jobs + 1, credits: waiting.credits + credits, where };
  clearTimeout(pending);
  pending = setTimeout(() => {
    const { jobs, credits, where } = waiting;
    waiting = { jobs: 0, credits: 0, where: "" };
    notify("Flow Studio: your OK is needed", `${jobs} job${jobs > 1 ? "s" : ""} waiting${where ? ` for ${where}` : ""} · at most ${credits} credits. Approve at ${STUDIO_URL}`);
    if (!studioOpen()) openUrl(STUDIO_URL);
  }, 400);
  pending.unref?.();
}
