// Credit guard: the user's own limits, a spending record that survives restarts, and the stops that keep a run from
// burning credits. Everything here is plain files in ~/.flow-mcp so the user can read and edit them:
//   budget.json   the limits (owned by the user; no tool can change it)
//   ledger.jsonl  one line per event: approved, started, quoted, finished, failed, settled
//   prices.json   prices learned from Flow's own quotes, so estimates get better with use
//   breaker.json  present while the circuit breaker is tripped
//   STOP          create this empty file to halt everything at once
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { HOME_DIR } from "./chrome.js";
import type { Job, SceneParams } from "./queue.js";

export const BUDGET_FILE = join(HOME_DIR, "budget.json");
export const LEDGER_FILE = join(HOME_DIR, "ledger.jsonl");
export const PRICES_FILE = join(HOME_DIR, "prices.json");
export const BREAKER_FILE = join(HOME_DIR, "breaker.json");
export const STOP_FILE = join(HOME_DIR, "STOP");

// Credits for ONE output. Keys are "model|seconds|resolution" or just "model", lower case. Flow's own quote always
// wins: these only make the estimate shown before approval. A model that is not listed is estimated at the per-job
// limit, the most it could be allowed to cost.
const DEFAULT_PRICES: Record<string, number> = {
  "omni 1.1 flash|4|360p": 4, "omni 1.1 flash|6|360p": 5, "omni 1.1 flash|8|360p": 6, "omni 1.1 flash|10|360p": 7,
  "omni 1.1 flash|4|720p": 7, "omni 1.1 flash|6|720p": 10, "omni 1.1 flash|8|720p": 12, "omni 1.1 flash|10|720p": 15,
  "veo 3.1 - lite": 10, "veo 3.1 - fast": 20, "veo 3.1 - quality": 100,
};
// Models priced by the second (their length is a slider). Keys are "model|resolution". Seen in Flow on 2026-11-11:
// Omni 1.2 Flash, 720p, 15 s = 60 credits. Assumed to scale evenly with length until Flow's quotes say otherwise.
const DEFAULT_PER_SECOND: Record<string, number> = { "omni 1.2 flash|720p": 4 };
const rateKey = (s: Pick<SceneParams, "model" | "resolution">) => `${norm(s.model)}|/s|${s.resolution ?? ""}`;

const budgetSchema = z.object({
  per_job: z.number().int().min(0),
  per_day: z.number().int().min(0),
  per_month: z.number().int().min(0),
  overrun_percent: z.number().min(0).max(500).default(25),
  approve_free: z.boolean().default(false),
  review_dir: z.string().default(""),
  prices: z.record(z.string(), z.number().min(0)).default({}),
});
export type Budget = z.infer<typeof budgetSchema>;

const DEFAULT_BUDGET = {
  _help: [
    "Your limits for Flow credits. Only you change this file; Claude and the tools cannot.",
    "per_job: the most one clip may cost. per_day / per_month: the most all jobs together may cost.",
    "overrun_percent: if a job really costs this much more than you approved, everything stops until you press Resume.",
    "approve_free: true makes free image jobs wait for your Approve click as well.",
    "review_dir: a folder that gets a copy of every result plus a small .json with its prompt and cost. Empty = off.",
    "prices: your own price list, credits for one output, e.g. \"omni 1.2|8|720p\": 30. Flow's real quote always wins.",
  ],
  per_job: 40,
  per_day: 200,
  per_month: 900,
  overrun_percent: 25,
  approve_free: false,
  review_dir: "",
  prices: {},
};

// A budget that cannot be read stops paid work: failing open would defeat the point of having limits.
export function loadBudget(): Budget {
  mkdirSync(HOME_DIR, { recursive: true });
  if (!existsSync(BUDGET_FILE)) writeFileSync(BUDGET_FILE, JSON.stringify(DEFAULT_BUDGET, null, 2) + "\n");
  try {
    return budgetSchema.parse(JSON.parse(readFileSync(BUDGET_FILE, "utf8")));
  } catch (err) {
    const why = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
    throw new Error(`The budget file ${BUDGET_FILE} cannot be read (${why}). Fix it, or delete it to get the defaults back. Nothing that costs credits runs until then.`);
  }
}

const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const priceKey = (s: Pick<SceneParams, "model" | "duration" | "resolution">) => `${norm(s.model)}|${s.duration ?? ""}|${s.resolution ?? ""}`;

function learned(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(PRICES_FILE, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

// Called with Flow's own quote just before a generation, so the next estimate for the same settings is exact.
export function learnPrice(s: SceneParams, quote: number): void {
  if (s.type !== "video" || !s.model || !Number.isFinite(quote)) return;
  try {
    const all = learned();
    all[priceKey(s)] = Math.ceil(quote / (s.variants ?? 1));
    if (s.duration) all[rateKey(s)] = Math.round((quote / (s.variants ?? 1) / s.duration) * 100) / 100;
    writeFileSync(PRICES_FILE, JSON.stringify(all, null, 2) + "\n");
  } catch {
    // An estimate aid only: never let it break a generation.
  }
}

export interface Estimate {
  credits: number;
  // true when Flow shows a quote before the click, so the approved amount is a hard ceiling for this job.
  quoted: boolean;
  paid: boolean;
  basis: string;
}

type Priced = Pick<SceneParams, "type" | "model" | "duration" | "resolution" | "variants" | "edit_asset" | "continue_from" | "agent_scenes">;

export function estimate(s: Priced, budget: Budget): Estimate {
  if (s.edit_asset) return { credits: budget.per_job, quoted: false, paid: true, basis: "video edit: Flow shows no price beforehand, so your per-job limit is set aside and the real cost is measured afterwards" };
  if (s.continue_from) return { credits: budget.per_job, quoted: false, paid: true, basis: "continue a clip: Flow shows no price beforehand, so your per-job limit is set aside and the real cost is measured afterwards" };
  if (s.agent_scenes) return { credits: 0, quoted: false, paid: false, basis: "image batch: free; the balance is checked afterwards" };
  if (s.type === "image") return { credits: 0, quoted: true, paid: false, basis: "image: free; refused if Flow quotes anything above 0" };
  const n = s.variants ?? 1;
  const mine = Object.fromEntries(Object.entries(budget.prices).map(([k, v]) => [norm(k), v]));
  const seen = learned();
  const key = priceKey(s);
  const hit = (table: Record<string, number>) => table[key] ?? table[norm(s.model)];
  const own = s.model ? hit(mine) : undefined;
  if (own !== undefined) return { credits: own * n, quoted: true, paid: true, basis: "your price list in budget.json" };
  const past = s.model ? seen[key] : undefined;
  if (past !== undefined) return { credits: past * n, quoted: true, paid: true, basis: "Flow's own quote from an earlier run" };
  const listed = s.model ? hit(DEFAULT_PRICES) : undefined;
  if (listed !== undefined) return { credits: listed * n, quoted: true, paid: true, basis: "built-in price list (may be out of date)" };
  if (s.model && s.duration) {
    const rate = seen[rateKey(s)];
    if (rate !== undefined) return { credits: Math.ceil(rate * s.duration) * n, quoted: true, paid: true, basis: `${rate} credits a second, from Flow's quote for another length; Flow's quote for this one is checked before anything is spent` };
    // "Omni 1.2" should find "Omni 1.2 Flash": Flow's menu is matched the same loose way.
    const known = Object.entries(DEFAULT_PER_SECOND).find(([k]) => k.split("|")[0].includes(norm(s.model)) && k.split("|")[1] === (s.resolution ?? ""));
    if (known) return { credits: Math.ceil(known[1] * s.duration) * n, quoted: true, paid: true, basis: `${known[1]} credits a second (built-in, seen 2026-11-11); Flow's quote is checked before anything is spent` };
  }
  return { credits: budget.per_job, quoted: true, paid: true, basis: `price not known for ${s.model ? `"${s.model}"` : "Flow's current model"}: at most your per-job limit; Flow's quote is checked before anything is spent` };
}

type LedgerEvent = "approved" | "started" | "quoted" | "finished" | "failed" | "settled";
interface Entry {
  t: string;
  id: string;
  event: LedgerEvent;
  project?: string;
  scene?: string;
  credits?: number;
  note?: string;
}

export function record(event: LedgerEvent, job: Pick<Job, "id" | "params">, credits?: number, note?: string): void {
  mkdirSync(HOME_DIR, { recursive: true });
  const entry: Entry = { t: new Date().toISOString(), id: job.id, event, project: basename(job.params.output_dir), scene: job.params.file_stem, credits, note };
  appendFileSync(LEDGER_FILE, JSON.stringify(entry) + "\n");
}

export function settle(id: string, credits: number): void {
  mkdirSync(HOME_DIR, { recursive: true });
  appendFileSync(LEDGER_FILE, JSON.stringify({ t: new Date().toISOString(), id, event: "settled", credits } satisfies Entry) + "\n");
}

function entries(): Entry[] {
  if (!existsSync(LEDGER_FILE)) return [];
  const out: Entry[] = [];
  for (const line of readFileSync(LEDGER_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Entry);
    } catch {
      // A damaged line is skipped, not fatal: the rest of the record still counts.
    }
  }
  return out;
}

// Local calendar day, so "today" means the user's day and not UTC's.
const dayOf = (iso: string | Date) => new Date(iso).toLocaleDateString("sv-SE");

export interface Spend {
  today: number;
  month: number;
  // Jobs that started and never reported a cost (the tool restarted, or the balance could not be read). They count
  // at the amount that was set aside until the user says what they really cost.
  unsettled: { id: string; project?: string; scene?: string; started: string; counted: number }[];
}

// What has been spent, from the record. A job that started counts from that moment: at its real cost once known,
// and at the approved amount until then, because a job that vanished mid-run may still have been charged.
export function spend(running: Set<string> = new Set(), now = new Date()): Spend {
  // real: what finished attempts are known to have cost. open: an attempt started and its cost is not known yet.
  const jobs = new Map<string, { started?: Entry; approved?: number; quote?: number; real: number; open: boolean }>();
  for (const e of entries()) {
    const j = jobs.get(e.id) ?? { real: 0, open: false };
    if (e.event === "approved") j.approved = e.credits;
    else if (e.event === "started") {
      j.started = e;
      j.open = true;
    } else if (e.event === "quoted") j.quote = e.credits;
    else if ((e.event === "finished" || e.event === "failed" || e.event === "settled") && e.credits !== undefined) {
      j.real += e.credits;
      j.open = false;
    }
    // finished/failed with no cost attached leaves the attempt open: it stays counted at the amount set aside.
    jobs.set(e.id, j);
  }
  const today = dayOf(now);
  const out: Spend = { today: 0, month: 0, unsettled: [] };
  for (const [id, j] of jobs) {
    if (!j.started) continue;
    const aside = j.open ? (j.quote ?? j.approved ?? 0) : 0;
    const counted = j.real + aside;
    const day = dayOf(j.started.t);
    if (day === today) out.today += counted;
    if (day.slice(0, 7) === today.slice(0, 7)) out.month += counted;
    if (j.open && !running.has(id)) out.unsettled.push({ id, project: j.started.project, scene: j.started.scene, started: j.started.t, counted: aside });
  }
  return out;
}

export function breaker(): { reason: string; t: string } | null {
  try {
    return JSON.parse(readFileSync(BREAKER_FILE, "utf8")) as { reason: string; t: string };
  } catch {
    return null;
  }
}

export function trip(reason: string): void {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(BREAKER_FILE, JSON.stringify({ reason, t: new Date().toISOString() }, null, 2) + "\n");
}

export const resume = (): void => rmSync(BREAKER_FILE, { force: true });

// The reason nothing may be spent right now, or null. `extra` is what is about to be set aside on top of the record.
export function blocked(extra: number, running?: Set<string>): string | null {
  if (existsSync(STOP_FILE)) return `Stopped: the file ${STOP_FILE} exists. Delete it to carry on.`;
  const b = breaker();
  if (b) return `Stopped by the safety breaker: ${b.reason} Press Resume in Flow Studio once you have checked.`;
  let budget: Budget;
  try {
    budget = loadBudget();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (extra <= 0) return null;
  const s = spend(running);
  if (s.today + extra > budget.per_day) return `Daily limit: ${s.today} of ${budget.per_day} credits are used or set aside today, and this needs up to ${extra} more. Raise per_day in ${BUDGET_FILE} or wait until tomorrow.`;
  if (s.month + extra > budget.per_month) return `Monthly limit: ${s.month} of ${budget.per_month} credits are used or set aside this month, and this needs up to ${extra} more. Raise per_month in ${BUDGET_FILE}.`;
  return null;
}

// After a job: did it cost clearly more than the user approved? Then stop everything until they have looked.
export function checkOverrun(job: Pick<Job, "id" | "params">, approved: number, spent: number): string | null {
  let pct = 25;
  try {
    pct = loadBudget().overrun_percent;
  } catch {
    // Keep the default: a broken budget file already blocks new work.
  }
  if (spent <= approved * (1 + pct / 100) || spent <= approved) return null;
  const reason = `${basename(job.params.output_dir)} ${job.params.file_stem} cost ${spent} credits, but ${approved} were approved.`;
  trip(reason);
  return reason;
}

export function budgetView(running: Set<string>, waiting: { count: number; credits: number }) {
  const stop = existsSync(STOP_FILE);
  const b = breaker();
  try {
    const budget = loadBudget();
    const s = spend(running);
    return {
      limits: { per_job: budget.per_job, per_day: budget.per_day, per_month: budget.per_month },
      spent_today: s.today,
      spent_month: s.month,
      left_today: Math.max(0, budget.per_day - s.today),
      left_month: Math.max(0, budget.per_month - s.month),
      waiting_for_approval: waiting,
      stopped: stop ? `STOP file present (${STOP_FILE})` : b ? b.reason : null,
      breaker: Boolean(b),
      unsettled: s.unsettled,
      review_dir: budget.review_dir || null,
      budget_file: BUDGET_FILE,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), stopped: "budget file unreadable", breaker: Boolean(b), budget_file: BUDGET_FILE };
  }
}

// Copies a finished job's files into the review folder with a small record of how each was made. Best effort: a
// folder macOS will not let this process write to must never cost the user a finished clip.
export function copyForReview(job: Job): string | undefined {
  let dir = "";
  try {
    dir = loadBudget().review_dir;
  } catch {
    return undefined;
  }
  if (!dir || !job.files.length) return undefined;
  try {
    const target = join(dir, basename(job.params.output_dir));
    mkdirSync(target, { recursive: true });
    for (const f of job.files) copyFileSync(f, join(target, basename(f)));
    const { prompt, type, model, duration, resolution, aspect_ratio, variants, first_frame, last_frame, reference_images, edit_asset, continue_from } = job.params;
    const card = { made: new Date().toISOString(), job: job.id, files: job.files.map((f) => basename(f)), prompt, type, model, duration, resolution, aspect_ratio, variants, first_frame, last_frame, reference_images, edit_asset, continue_from, credits_approved: job.approved, credits_quoted: job.credits, credits_spent: job.spent, note: job.note };
    writeFileSync(join(target, `${job.params.file_stem}.json`), JSON.stringify(card, null, 2) + "\n");
    return target;
  } catch (err) {
    return `could not copy to the review folder (${err instanceof Error ? err.message : err})`;
  }
}
