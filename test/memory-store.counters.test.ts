import { test } from "node:test";
import assert from "node:assert/strict";
import MemoryStore from "../src/memory-store";
import { RedisStoreRecord } from "../src/index";

type Entry = RedisStoreRecord & { userId: string, vice: string, date: string, week: string, type: string };

function makeStore() {
  return new MemoryStore<Entry>({
    key: "Entry",
    options: {
      counters: ["user:vice", "user:date:week:type"],
    },
  });
}

test("incCounters + queryCounter('count'/'totals'/'counts') for a single-dim counter", async () => {
  const store = makeStore();

  await store.incCounters({ user: "u1", vice: "coffee" }, { total: 100, count: 1 });
  await store.incCounters({ user: "u1", vice: "coffee" }, { total: 50, count: 1 });
  await store.incCounters({ user: "u1", vice: "soda" }, { total: 10, count: 1 });

  assert.equal(await store.queryCounter("count", "user:vice", { user: "u1" }), 2);

  const totals = await store.queryCounter("totals", "user:vice", { user: "u1" }) as any[];
  const byMember = Object.fromEntries(totals.map((t) => [t.member, t.score]));
  assert.equal(byMember["user=u1:vice=coffee"], 150);
  assert.equal(byMember["user=u1:vice=soda"], 10);

  const counts = await store.queryCounter("counts", "user:vice", { user: "u1" }) as any[];
  assert.equal(counts.find((c) => c.member === "user=u1:vice=coffee")?.score, 2);
});

// Mirrors ViceEntryOptions' real "user:date:week:type" shape, where the ranged
// field ("date") is NOT the last dimension in the counter -- this is the case
// that exercises the \x00/\x7f sentinel bytes in queryCounter's range bounds.
test("queryCounter respects a date range when the ranged field isn't the last dimension", async () => {
  const store = makeStore();

  const rows = [
    { date: "20250101", week: "1", type: "coffee" },
    { date: "20250115", week: "3", type: "coffee" },
    { date: "20250115", week: "3", type: "soda" },
    { date: "20250201", week: "5", type: "coffee" },
  ];

  for (const row of rows) {
    await store.incCounters({ user: "u1", ...row }, { total: 1, count: 1 });
  }
  // a different user should never leak into a scoped query
  await store.incCounters({ user: "u2", date: "20250115", week: "3", type: "coffee" }, { total: 1, count: 1 });

  const inRange = await store.queryCounter(
    "counts",
    "user:date:week:type",
    { user: "u1" },
    { field: "date", min: "20250101", max: "20250131" }
  ) as any[];

  assert.deepEqual(
    inRange.map((r) => r.member).sort(),
    ["user=u1:date=20250101:week=1:type=coffee", "user=u1:date=20250115:week=3:type=coffee", "user=u1:date=20250115:week=3:type=soda"].sort()
  );

  const exactCount = await store.queryCounter(
    "count",
    "user:date:week:type",
    { user: "u1" },
    { field: "date", min: "20250101", max: "20250131" }
  );
  assert.equal(exactCount, 3);
});

test("incCounters warns and skips a counter whose dimensions aren't all present in values", async () => {
  const store = makeStore();
  const warnings: any[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: any[]) => warnings.push(args);

  try {
    // "user:date:week:type" needs date/week/type too -- only "user:vice" can be incremented
    await store.incCounters({ user: "u1", vice: "coffee" }, { total: 100, count: 1 });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /skipping counter "user:date:week:type"/);
  assert.match(warnings[0][0], /date, week, type/);

  // the well-formed counter still gets incremented despite the other one being skipped
  assert.equal(await store.queryCounter("count", "user:vice", { user: "u1" }), 1);
});
