// PATH for a Dock-launched app on a Mac: Homebrew's folders must be found. No Chrome, no Flow, no credits.
import assert from "node:assert/strict";
import { test } from "node:test";

const { withHomebrewPath } = await import("../dist/platform.js");

test("on a Mac the two Homebrew folders are added after the existing PATH", () => {
  assert.equal(withHomebrewPath("/usr/bin:/bin", true), "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
});

test("folders already on the PATH are not repeated and keep their place", () => {
  assert.equal(withHomebrewPath("/opt/homebrew/bin:/usr/bin", true), "/opt/homebrew/bin:/usr/bin:/usr/local/bin");
});

test("an empty or missing PATH still gets both folders", () => {
  assert.equal(withHomebrewPath(undefined, true), "/opt/homebrew/bin:/usr/local/bin");
  assert.equal(withHomebrewPath("", true), "/opt/homebrew/bin:/usr/local/bin");
});

test("other systems are left alone", () => {
  assert.equal(withHomebrewPath("/usr/bin", false), "/usr/bin");
});
