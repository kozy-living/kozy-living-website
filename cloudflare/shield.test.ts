// node --test cloudflare/shield.test.ts   (Node strips the types itself)
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, holdMs, IDLE, type ShieldState } from "./shield.ts";

const H = 60 * 60 * 1000;
const T = 3000;
const t0 = Date.UTC(2026, 10, 16, 12);

const holdingSince = (at: number, strikes = 1): ShieldState => ({
  raisedAt: at,
  lastRaisedAt: at,
  previousLevel: "medium",
  strikes,
});

test("calm and idle: nothing happens", () => {
  const d = decide(IDLE, "medium", 400, T, t0);
  assert.equal(d.action, "none");
  assert.deepEqual(d.state, IDLE);
});

test("a flood raises Under Attack and remembers the level it found", () => {
  const d = decide(IDLE, "medium", 9000, T, t0);
  assert.equal(d.action, "raise");
  assert.deepEqual(d.state, { raisedAt: t0, lastRaisedAt: t0, previousLevel: "medium", strikes: 1 });
});

test("exactly at the threshold is not a flood", () => {
  assert.equal(decide(IDLE, "medium", T, T, t0).action, "none");
});

test("while holding: still flooding or calm, it holds", () => {
  const s = holdingSince(t0);
  assert.equal(decide(s, "under_attack", 9000, T, t0 + 5 * 60_000).action, "none");
  // Calm because the challenge hides the flood - must not drop early.
  assert.equal(decide(s, "under_attack", 0, T, t0 + 30 * 60_000).action, "none");
  assert.equal(decide(s, "under_attack", 0, T, t0 + 2 * H - 1).action, "none");
});

test("after the hold, calm restores the previous level", () => {
  const d = decide(holdingSince(t0), "under_attack", 50, T, t0 + 2 * H);
  assert.equal(d.action, "lower");
  assert.equal(d.action === "lower" && d.level, "medium");
  assert.equal(d.state.raisedAt, 0);
  assert.equal(d.state.strikes, 1, "strikes survive lowering");
});

test("a flood that returns within a day is held twice as long", () => {
  const lowered = decide(holdingSince(t0), "under_attack", 50, T, t0 + 2 * H).state;
  const again = decide(lowered, "medium", 9000, T, t0 + 2 * H + 5 * 60_000);
  assert.equal(again.action, "raise");
  assert.equal(again.state.strikes, 2);
  assert.equal(holdMs(2), 4 * H);
  // ...and still holding 3h later.
  assert.equal(decide(again.state, "under_attack", 0, T, t0 + 5 * H).action, "none");
});

test("a flood more than a day later starts again at strike 1", () => {
  const lowered = decide(holdingSince(t0), "under_attack", 50, T, t0 + 2 * H).state;
  const later = decide(lowered, "medium", 9000, T, t0 + 25 * H);
  assert.equal(later.action, "raise");
  assert.equal(later.state.strikes, 1);
});

test("the hold never exceeds a day", () => {
  assert.equal(holdMs(1), 2 * H);
  assert.equal(holdMs(4), 16 * H);
  assert.equal(holdMs(5), 24 * H);
  assert.equal(holdMs(50), 24 * H);
});

test("Under Attack set by hand is never touched", () => {
  assert.equal(decide(IDLE, "under_attack", 9000, T, t0).action, "none");
  assert.equal(decide(IDLE, "under_attack", 0, T, t0 + 48 * H).action, "none");
});

test("lowered by hand while holding: the shield stands down", () => {
  const d = decide(holdingSince(t0), "medium", 0, T, t0 + H);
  assert.equal(d.action, "none");
  assert.equal(d.state.raisedAt, 0);
  // and a later calm round does not try to 'restore' anything
  assert.equal(decide(d.state, "medium", 0, T, t0 + 3 * H).action, "none");
});

test("restores whatever level it found, e.g. high", () => {
  const raised = decide(IDLE, "high", 9000, T, t0).state;
  const d = decide(raised, "under_attack", 0, T, t0 + 2 * H);
  assert.equal(d.action === "lower" && d.level, "high");
});
