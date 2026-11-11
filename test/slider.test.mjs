// Length-slider reading. No Chrome, no Flow, no credits.   npm run build && npm test
import assert from "node:assert/strict";
import { test } from "node:test";

const { sliderSeconds } = await import("../dist/slider.js");

test("a slider counted from 0 to 12 is a position: 4 means 7 s (the 2026-11-11 bug)", () => {
  assert.equal(sliderSeconds({ now: "4", min: "0", max: "12" }), 7);
  assert.equal(sliderSeconds({ now: "5", min: "0", max: "12" }), 8);
  assert.equal(sliderSeconds({ now: "0", min: "0", max: "12" }), 3);
  assert.equal(sliderSeconds({ now: "12", min: "0", max: "12" }), 15);
});

test("a slider that already spans 3-15 is in seconds", () => {
  assert.equal(sliderSeconds({ now: "4", min: "3", max: "15" }), 4);
  assert.equal(sliderSeconds({ now: "15", min: "3", max: "15" }), 15);
});

test("the slider's own text wins over the numbers", () => {
  assert.equal(sliderSeconds({ now: "4", text: "7s", min: "0", max: "12" }), 7);
  assert.equal(sliderSeconds({ now: "4", text: "7 seconds" }), 7);
});

test("unreadable gives NaN, and a bare number with no range is taken as seconds", () => {
  assert.ok(Number.isNaN(sliderSeconds({})));
  assert.ok(Number.isNaN(sliderSeconds({ now: "abc" })));
  assert.equal(sliderSeconds({ now: "9" }), 9);
});
