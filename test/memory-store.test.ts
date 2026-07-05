import { test } from "node:test";
import assert from "node:assert/strict";
import MemoryStore from "../src/memory-store";
import { RedisStoreRecord } from "../src/index";

type Thing = RedisStoreRecord & { userId: string, name: string };

function makeStore(options?: any) {
  return new MemoryStore<Thing>({ key: "Thing", options, debug: false });
}

test("create() assigns id/createdAt and get() round-trips", async () => {
  const store = makeStore();
  const created = await store.create({ name: "a" });

  assert.ok(created.id);
  assert.ok(created.createdAt);
  assert.equal(await store.get(created.id), created);
});

test("exists() is true even for soft-deleted, false after hard delete", async () => {
  const store = makeStore();
  const created = await store.create({ name: "a" });

  const deleted = await store.delete(created.id);
  assert.ok(deleted?.deletedAt);
  assert.equal(await store.exists(created.id), true);
  assert.equal(await store.get(created.id), undefined);
  assert.deepEqual(await store.get(created.id, { deleted: true }), { ...created, deletedAt: deleted!.deletedAt });

  const created2 = await store.create({ name: "b" });
  await store.delete(created2.id, { hardDelete: true });
  assert.equal(await store.exists(created2.id), false);
});

test("find() never returns soft-deleted records", async () => {
  const store = makeStore();
  const a = await store.create({ name: "a" });
  const b = await store.create({ name: "b" });
  await store.delete(a.id);

  const found = await store.find();
  assert.deepEqual(found.map((v) => v.id), [b.id]);
});

test("update() throws for missing id or nonexistent record, otherwise merges + stamps updatedAt", async () => {
  const store = makeStore();
  const created = await store.create({ name: "a" });

  await assert.rejects(() => store.update({ name: "x" } as any), /null id/);
  await assert.rejects(() => store.update({ id: "missing", name: "x" }), /does not exist/);

  const updated = await store.update({ ...created, name: "a2" });
  assert.equal(updated.name, "a2");
  assert.ok(updated.updatedAt);
});

test("lookups: find()/ids() resolve by a single lookup key, newest first", async () => {
  const store = makeStore({ lookups: { user: "userId" } });
  const a = await store.create({ userId: "u1", name: "a" });
  await new Promise((r) => setTimeout(r, 2));
  const b = await store.create({ userId: "u1", name: "b" });
  await store.create({ userId: "u2", name: "c" });

  const found = await store.find({ user: "u1" });
  assert.deepEqual(found.map((v) => v.id), [b.id, a.id]);
});

test("lookups: find() with multiple lookup keys intersects", async () => {
  const store = makeStore({ lookups: { user: "userId", name: "name" } });
  const a = await store.create({ userId: "u1", name: "shared" });
  await store.create({ userId: "u1", name: "other" });
  await store.create({ userId: "u2", name: "shared" });

  const found = await store.find({ user: "u1", name: "shared" });
  assert.deepEqual(found.map((v) => v.id), [a.id]);
});

test("update() moves a record between lookup buckets", async () => {
  const store = makeStore({ lookups: { user: "userId" } });
  const a = await store.create({ userId: "u1", name: "a" });

  await store.update({ ...a, userId: "u2" });

  assert.deepEqual((await store.find({ user: "u1" })).map((v) => v.id), []);
  assert.deepEqual((await store.find({ user: "u2" })).map((v) => v.id), [a.id]);
});

test("count/offset windows ids() same as a rank-based range", async () => {
  const store = makeStore();
  const created = [] as Thing[];
  for (let i = 0; i < 5; i++) {
    created.push(await store.create({ name: `${i}`, createdAt: i }));
  }

  const page1 = await store.find({ count: 2 });
  assert.deepEqual(page1.map((v) => v.name), ["4", "3"]);

  const page2 = await store.find({ count: 2, offset: 2 });
  assert.deepEqual(page2.map((v) => v.name), ["2", "1"]);
});

test("constructor seed makes records immediately queryable via lookups", async () => {
  const store = new MemoryStore<Thing>({
    key: "Thing",
    options: { lookups: { user: "userId" } },
    seed: [
      { id: "1", createdAt: 100, userId: "u1", name: "seeded-a" },
      { id: "2", createdAt: 200, userId: "u1", name: "seeded-b" },
    ],
  });

  assert.equal(await store.exists("1"), true);
  const found = await store.find({ user: "u1" });
  assert.deepEqual(found.map((v) => v.id), ["2", "1"]);
});
