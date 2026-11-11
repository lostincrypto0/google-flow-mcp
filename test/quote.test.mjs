// A quote read from Flow (learnPrice) becomes the next estimate. No Chrome, no Flow, no credits.
//   npm run build && npm test
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "flow-quote-"));
process.env.FLOW_MCP_HOME = home;
const g = await import("../dist/guard.js");
writeFileSync(g.BUDGET_FILE, JSON.stringify({ per_job: 40, per_day: 200, per_month: 900, overrun_percent: 25 }));
rmSync(g.PRICES_FILE, { force: true });

const scene = (duration) => ({ type: "video", model: "Omni 1.2 Flash", duration, resolution: "720p" });

test("before any quote the estimate is the built-in ceiling", () => {
  const e = g.estimate(scene(5), g.loadBudget());
  assert.equal(e.credits, 20);
});

test("after Flow's quote for 5 s, the same settings estimate exactly that", () => {
  g.learnPrice({ ...scene(5), prompt: "p", max_credits: 0, output_dir: "", file_stem: "x" }, 15);
  const e = g.estimate(scene(5), g.loadBudget());
  assert.equal(e.credits, 15);
  assert.match(e.basis, /Flow's own quote/);
});

test("another length uses the learned per-second rate, rounded up", () => {
  const e = g.estimate(scene(6), g.loadBudget());
  assert.equal(e.credits, 18); // 3 credits a second x 6 s
});

test("two variants cost twice the learned price", () => {
  const e = g.estimate({ ...scene(5), variants: 2 }, g.loadBudget());
  assert.equal(e.credits, 30);
});
