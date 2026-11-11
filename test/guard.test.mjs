// Credit guard checks. They use a scratch folder and a fake runner: no Chrome, no Flow, no credits.
//   npm run build && npm test
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "flow-guard-"));
process.env.FLOW_MCP_HOME = home;
process.env.FLOW_MCP_PAUSE_MIN_S = "0";
process.env.FLOW_MCP_PAUSE_MAX_S = "0";
const g = await import("../dist/guard.js");
const { JobQueue } = await import("../dist/queue.js");

const budget = (o = {}) => writeFileSync(g.BUDGET_FILE, JSON.stringify({ per_job: 40, per_day: 100, per_month: 150, overrun_percent: 25, ...o }));
const reset = () => { for (const f of [g.LEDGER_FILE, g.PRICES_FILE, g.BREAKER_FILE, g.STOP_FILE]) rmSync(f, { force: true }); budget(); };
const job = (id, extra = {}) => ({ id, params: { prompt: "p", type: "video", max_credits: 0, output_dir: "/x/Film", file_stem: `scene-${id}`, ...extra } });
const idle = (q) => new Promise((ok) => { const t = setInterval(() => { if (!q.list().some((j) => j.status === "queued" || j.status === "running")) { clearInterval(t); ok(); } }, 5); });

test("first run writes a budget file with the default limits", () => {
  rmSync(g.BUDGET_FILE, { force: true });
  const b = g.loadBudget();
  assert.deepEqual([b.per_job, b.per_day, b.per_month], [40, 200, 900]);
  assert.ok(existsSync(g.BUDGET_FILE));
});

test("a broken budget file blocks spending instead of failing open", () => {
  writeFileSync(g.BUDGET_FILE, "{ not json");
  assert.throws(() => g.loadBudget(), /cannot be read/);
  assert.match(g.blocked(1), /cannot be read/);
  reset();
});

test("estimates: free images, known and unknown video prices, unquoted actions", () => {
  reset();
  const b = g.loadBudget();
  assert.deepEqual([g.estimate({ type: "image" }, b).credits, g.estimate({ type: "image" }, b).paid], [0, false]);
  assert.equal(g.estimate({ type: "video", model: "Omni 1.1 Flash", duration: 8, resolution: "720p" }, b).credits, 12);
  assert.equal(g.estimate({ type: "video", model: "Veo 3.1 - Fast", variants: 2 }, b).credits, 40);
  // Unknown model: the most it may cost is the per-job limit.
  assert.equal(g.estimate({ type: "video", model: "Omni 1.2", duration: 8 }, b).credits, 40);
  assert.equal(g.estimate({ type: "video" }, b).credits, 40);
  const edit = g.estimate({ type: "video", edit_asset: "clip" }, b);
  assert.deepEqual([edit.credits, edit.quoted, edit.paid], [40, false, true]);
  assert.equal(g.estimate({ type: "image", agent_scenes: ["a"] }, b).credits, 0);
});

test("a price learned from Flow's quote, and the user's own price list, replace the guess", () => {
  reset();
  const s = { type: "video", model: "Omni 1.2", duration: 8, resolution: "720p", variants: 2 };
  g.learnPrice(s, 60);
  assert.equal(g.estimate({ ...s, variants: 1 }, g.loadBudget()).credits, 30);
  budget({ prices: { "Omni 1.2|8|720p": 28 } });
  assert.equal(g.estimate({ ...s, variants: 1 }, g.loadBudget()).credits, 28);
});

test("Omni 1.2 is priced by the second, and a quote for one length prices the others", () => {
  reset();
  const b = g.loadBudget(), omni = { type: "video", model: "Omni 1.2", resolution: "720p" };
  assert.deepEqual([4, 10, 15].map((duration) => g.estimate({ ...omni, duration }, b).credits), [16, 40, 60]);
  assert.equal(g.estimate({ ...omni, duration: 4, variants: 2 }, b).credits, 32);
  assert.equal(g.estimate(omni, b).credits, 40, "no length given: the per-job limit");
  g.learnPrice({ ...omni, duration: 4 }, 20);                       // Flow quoted 5 a second
  assert.equal(g.estimate({ ...omni, duration: 4 }, b).credits, 20);
  assert.equal(g.estimate({ ...omni, duration: 7 }, b).credits, 35);
});

test("spending is counted from the record: real cost when known, the approved amount until then", () => {
  reset();
  const a = job("a"), b = job("b"), c = job("c");
  g.record("approved", a, 12); g.record("started", a, 12); g.record("finished", a, 10);
  g.record("approved", b, 40); g.record("started", b, 40); g.record("quoted", b, 30);            // vanished mid-run
  g.record("approved", c, 20);                                                                    // approved, never started
  const s = g.spend();
  assert.deepEqual([s.today, s.month], [40, 40]);
  assert.deepEqual(s.unsettled.map((u) => [u.id, u.counted]), [["b", 30]]);
  assert.equal(g.spend(new Set(["b"])).unsettled.length, 0, "a job that is running right now is not unsettled");
  g.settle("b", 0);
  assert.deepEqual([g.spend().today, g.spend().unsettled.length], [10, 0]);
});

test("a failed job whose cost could not be read stays counted; a retry adds to it", () => {
  reset();
  const a = job("a");
  g.record("approved", a, 20); g.record("started", a, 20); g.record("failed", a, undefined, "timeout");
  assert.equal(g.spend().today, 20);
  g.settle("a", 20);
  g.record("approved", a, 20); g.record("started", a, 20); g.record("finished", a, 18);
  assert.equal(g.spend().today, 38);
});

test("yesterday and last month do not count against today and this month", () => {
  reset();
  const line = (t, id, event, credits) => JSON.stringify({ t, id, event, credits }) + "\n";
  const now = new Date(2026, 10, 11, 12), yesterday = new Date(2026, 10, 10, 12).toISOString(), october = new Date(2026, 9, 20, 12).toISOString();
  writeFileSync(g.LEDGER_FILE, line(yesterday, "y", "started", 30) + line(yesterday, "y", "finished", 30) + line(october, "o", "started", 99) + line(october, "o", "finished", 99));
  const s = g.spend(new Set(), now);
  assert.deepEqual([s.today, s.month], [0, 30]);
});

test("daily and monthly limits, the STOP file and the breaker all block", () => {
  reset();
  const a = job("a");
  g.record("started", a, 90); g.record("finished", a, 90);
  assert.equal(g.blocked(10), null);
  assert.match(g.blocked(11), /Daily limit/);
  budget({ per_day: 1000 });
  assert.match(g.blocked(61), /Monthly limit/);
  writeFileSync(g.STOP_FILE, "");
  assert.match(g.blocked(0), /STOP/);
  rmSync(g.STOP_FILE);
  assert.equal(g.checkOverrun(a, 20, 25), null, "within 25 %");
  assert.match(g.checkOverrun(a, 20, 26), /cost 26 credits, but 20 were approved/);
  assert.match(g.blocked(0), /safety breaker/);
  g.resume();
  assert.equal(g.blocked(0), null);
  assert.match(g.checkOverrun(a, 0, 3), /cost 3/, "anything charged for a job approved as free trips it");
  g.resume();
});

test("queue: a held job does not run until approved, and the approved amount becomes its ceiling", async () => {
  reset();
  const ran = [];
  const q = new JobQueue(async (j) => { ran.push([j.id, j.params.max_credits]); return []; }, () => null);
  const paid = q.add(job("x").params, { estimate: 30, paid: true, hold: true });
  const free = q.add(job("y", { type: "image" }).params, { estimate: 0, paid: false });
  await idle(q);
  assert.equal(paid.status, "awaiting_approval");
  assert.deepEqual(ran, [[free.id, 0]]);
  q.approve(paid.id, 30);
  await idle(q);
  assert.deepEqual(ran[1], [paid.id, 30]);
  assert.equal(paid.status, "done");
});

test("queue: a paid job never retries by itself and goes back for approval when retried", async () => {
  reset();
  let runs = 0;
  const q = new JobQueue(async () => { runs++; throw new Error("The agent finished without creating a clip"); }, () => null);
  const paid = q.add(job("x").params, { estimate: 30, paid: true, hold: true });
  q.approve(paid.id, 30);
  await idle(q);
  assert.deepEqual([runs, paid.status], [1, "failed"]);
  q.retry(paid.id);
  await idle(q);
  assert.deepEqual([runs, paid.status, paid.approved], [1, "awaiting_approval", undefined]);
  const free = q.add(job("y", { type: "image" }).params, { estimate: 0, paid: false });
  await idle(q);
  assert.deepEqual([runs, free.status], [3, "failed"], "a free job still gets its one automatic retry");
});

test("queue: a stop sends everything queued back to waiting and runs nothing", async () => {
  reset();
  let runs = 0, stop = "Daily limit reached";
  const q = new JobQueue(async () => { runs++; return []; }, () => stop);
  const a = q.add(job("a").params, { estimate: 10, paid: true, hold: true }), b = q.add(job("b").params, { estimate: 10, paid: true, hold: true });
  q.approve(a.id, 10); q.approve(b.id, 10);
  await idle(q);
  assert.deepEqual([runs, a.status, b.status, a.note, a.approved], [0, "awaiting_approval", "awaiting_approval", stop, undefined]);
  stop = null;
  q.approve(a.id, 10);
  await idle(q);
  assert.deepEqual([runs, a.status, b.status], [1, "done", "awaiting_approval"]);
});

test("review folder gets a copy and a record of how it was made", () => {
  reset();
  const review = join(home, "review"), src = join(home, "scene-01.jpg");
  writeFileSync(src, "img");
  budget({ review_dir: review });
  const j = { ...job("r", { type: "image", model: "Nano Banana" }), files: [src], approved: 0, spent: 0, credits: 0 };
  assert.equal(g.copyForReview(j), join(review, "Film"));
  const card = JSON.parse(readFileSync(join(review, "Film", "scene-r.json"), "utf8"));
  assert.deepEqual([card.prompt, card.model, card.credits_spent, card.files], ["p", "Nano Banana", 0, ["scene-01.jpg"]]);
  assert.ok(existsSync(join(review, "Film", "scene-01.jpg")));
});

test.after(() => rmSync(home, { recursive: true, force: true }));
