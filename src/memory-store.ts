import { uuid } from "@desmat/utils";
import type { RedisStoreRecord } from "./index";
import type { Store } from "./store";

// mimics a Redis sorted set: members ordered by score, ties broken by member
// string ascending (Redis zset default ordering), with ZRANGE's index semantics
// (negative indices count from the end, e.g. -1 is the last element).
class SortedIdList {
  private entries: Array<{ id: string, score: number }> = [];

  add(id: string, score: number) {
    this.remove(id);
    this.entries.push({ id, score });
  }

  remove(id: string) {
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  private sorted() {
    return [...this.entries].sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  range(min: number, max: number, rev?: boolean): string[] {
    const ordered = rev ? this.sorted().reverse() : this.sorted();
    const len = ordered.length;
    const resolve = (i: number) => (i < 0 ? len + i : i);
    const start = Math.max(resolve(min), 0);
    const stop = Math.min(resolve(max), len - 1);

    if (len === 0 || start > stop) return [];

    return ordered.slice(start, stop + 1).map((e) => e.id);
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

// intersect() polyfills Set.prototype.intersection so this module has no load-order
// dependency on index.ts's IIFE that installs it globally.
function intersect(a: Set<string>, b: Set<string>): Set<string> {
  return new Set(Array.from(a).filter((value) => b.has(value)));
}

export default class MemoryStore<T extends RedisStoreRecord> implements Store<T> {
  key: string;
  setKey: string;
  options: any;
  debug: boolean;

  private records = new Map<string, T>();
  private index = new SortedIdList();
  private lookups = new Map<string, SortedIdList>();
  private counters = new Map<string, Map<string, number>>();

  constructor({
    key,
    setKey,
    options,
    debug,
    seed,
  }: {
    key: string,
    setKey?: string,
    options?: any,
    debug?: boolean,
    seed?: T[],
  }) {
    this.key = key;
    this.setKey = setKey || key + "s";
    this.options = options;
    this.debug = !!debug;

    (seed || []).forEach((value) => this._index(value));
  }

  lookupKeys(value: any, options?: { noLookup?: boolean, lookups?: any }) {
    options = { ...this.options, ...options };
    this.debug && console.log(`MemoryStore<${this.key}>.lookupKeys`, { value, options });

    const lookupKeys = !options?.noLookup && Object
      .entries(options?.lookups || {})
      .map((entry) => {
        const id = value.id;
        const lookupName = entry[0];
        const lookupKey = entry[1];
        // @ts-ignore
        const lookupId = value[lookupKey];
        return [`${this.setKey}:${lookupName}:${lookupId}`, id];
      }) || [];

    this.debug && console.log(`MemoryStore<${this.key}>.lookupKeys`, { options, lookupKeys });

    return lookupKeys;
  }

  // shared by the constructor's `seed` and create(): adds a record to the main
  // index and lookup indices without re-deriving id/createdAt defaults.
  private _index(value: T, options?: any) {
    this.records.set(value.id, value);
    !options?.noIndex && this.index.add(value.id, value.createdAt);

    const lookupKeys = this.lookupKeys(value, options);
    (lookupKeys || []).forEach(([lookupKey, id]: any) => {
      if (!this.lookups.has(lookupKey)) this.lookups.set(lookupKey, new SortedIdList());
      this.lookups.get(lookupKey)!.add(id, value.createdAt);
    });
  }

  async exists(id: string): Promise<boolean> {
    this.debug && console.log(`MemoryStore<${this.key}>.exists`, { id });

    return this.records.has(id);
  }

  async get(id: string, options?: any): Promise<T | undefined> {
    this.debug && console.log(`MemoryStore<${this.key}>.get`, { id });

    const value = this.records.get(id);

    return value && !(value.deletedAt && !options?.deleted) ? value : undefined;
  }

  async scan(query: any = {}): Promise<Set<string>> {
    this.debug && console.log(`MemoryStore<${this.key}>.scan`, { query });

    const count = query.count || 999;
    const pattern = globToRegExp(query.scan ?? "*");
    const keys = new Set<string>();

    for (const id of this.records.keys()) {
      if (keys.size >= count) break;
      if (pattern.test(id)) keys.add(id);
    }

    this.debug && console.log(`MemoryStore<${this.key}>.scan`, { keys });

    return keys;
  }

  async ids(query: any = {}): Promise<Set<string>> {
    this.debug && console.log(`MemoryStore<${this.key}>.ids`, { query });

    if (query.scan) {
      return this.scan(query);
    }

    let count = query.count;
    delete query.count;

    if (typeof (count) != "undefined" && typeof (count) != "number") {
      console.warn(`MemoryStore<${this.key}>.ids WARNING: query.count is not a number`);
      count = undefined;
    }

    let offset = query.offset;
    delete query.offset;

    if (typeof (offset) != "undefined" && typeof (offset) != "number") {
      console.warn(`MemoryStore<${this.key}>.ids WARNING: query.offset must be a number`);
      offset = undefined;
    }

    const min = offset || 0;
    const max = min + (count || 0) - 1;

    const queryEntries = query && Object.entries(query);

    if (!queryEntries?.length) {
      return new Set(this.index.range(min, max, true));
    }

    const setOfIds = queryEntries.map(([queryKey, queryVal]: [string, any]) => {
      if (queryVal) {
        const lookupKey = `${this.setKey}:${queryKey}:${queryVal}`;
        return new Set(this.lookups.get(lookupKey)?.range(min, max, true) || []);
      } else {
        throw `MemoryStore.ids(query) query must have key and value`;
      }
    });

    const ids = setOfIds.reduce((prev: Set<string> | undefined, curr: Set<string>) => intersect(curr, prev || curr), undefined) || new Set<string>();
    this.debug && console.log(`MemoryStore<${this.key}>.ids queried lookup key`, { query, setOfIds, ids });

    return ids;
  }

  async find(query: any = {}): Promise<T[]> {
    this.debug && console.log(`MemoryStore<${this.key}>.find`, { query });

    const ids: string[] = Array.isArray(query.id)
      ? query.id.filter(Boolean)
      : Array.from(await this.ids(query));

    const values = ids
      .map((id) => this.records.get(id))
      .filter((value): value is T => !!value && !value.deletedAt);

    this.debug && console.log(`MemoryStore<${this.key}>.find`, { values });

    return values;
  }

  async create(value: any, options?: { expire?: number, noIndex?: boolean, score?: number, noLookup?: boolean, lookups?: any }): Promise<T> {
    this.debug && console.log(`MemoryStore<${this.key}>.create`, { value, options, this_options: this.options });

    const now = Date.now();
    options = { ...this.options, ...options };

    const createdValue = {
      id: value.id || uuid(),
      createdAt: value.createdAt || now,
      ...value,
    };
    this.debug && console.log(`MemoryStore<${this.key}>.create`, { createdValue });

    this._index(createdValue, options);

    options?.expire && this.debug && console.log(`MemoryStore<${this.key}>.create ignoring options.expire (memory store is ephemeral)`);

    return createdValue;
  }

  async update(value: any, options?: any): Promise<T> {
    this.debug && console.log(`MemoryStore<${this.key}>.update`, { value, options });

    if (!value.id) {
      throw `Cannot update ${this.key}: null id`;
    }

    const prevValue = await this.get(value.id);

    if (!prevValue) {
      throw `Cannot update ${this.key}: does not exist: ${value.id}`;
    }

    const now = Date.now();
    options = { ...this.options, ...options };

    const updatedValue = {
      ...value,
      updatedAt: now,
    };

    // @ts-ignore
    const prevLookupKeys = new Map(this.lookupKeys(prevValue, options));
    // @ts-ignore
    const lookupKeys = new Map(this.lookupKeys(updatedValue, options));
    const lookupsToRemove = prevLookupKeys && Array.from(prevLookupKeys)
      .filter(([k, v]: any) => !lookupKeys || lookupKeys.get(k) != v);
    const lookupsToAdd = lookupKeys && Array.from(lookupKeys)
      .filter(([k, v]: any) => !prevLookupKeys || prevLookupKeys.get(k) != v);
    this.debug && console.log(`MemoryStore<${this.key}>.update`, { prevLookupKeys, lookupKeys, keysToRemove: lookupsToRemove, keysToAdd: lookupsToAdd });

    lookupsToRemove.forEach(([lookupKey, id]: any) => this.lookups.get(lookupKey)?.remove(id));

    this.records.set(value.id, updatedValue);
    lookupsToAdd.forEach(([lookupKey, id]: any) => {
      if (!this.lookups.has(lookupKey)) this.lookups.set(lookupKey, new SortedIdList());
      this.lookups.get(lookupKey)!.add(id, updatedValue.createdAt || updatedValue.updatedAt);
    });

    return updatedValue;
  }

  async incrementCounters(values: Record<string, string | number>, delta: { total: number, count: number }): Promise<any> {
    this.debug && console.log(`MemoryStore<${this.key}>.incrementCounters`, { values, delta });

    const counters: string[] = this.options?.counters || [];

    counters
      .filter((counter: string) => counter.split(":").every((d: string) => typeof values[d] != "undefined"))
      .forEach((counter: string) => {
        const member = counter.split(":").map((d: string) => `${d}=${values[d]}`).join(":");

        [
          [`${this.key}Totals:${counter}`, delta.total],
          [`${this.key}Counts:${counter}`, delta.count],
        ].forEach(([setKey, d]: any) => {
          if (!this.counters.has(setKey)) this.counters.set(setKey, new Map());
          const counterMap = this.counters.get(setKey)!;
          counterMap.set(member, (counterMap.get(member) || 0) + d);
        });
      });
  }

  async queryCounter(
    kind: "count" | "counts" | "totals",
    counter: string,
    exact: Record<string, string | number>,
    range?: { field: string, min?: string, max?: string }
  ): Promise<number | Array<{ member: string, score: number }>> {
    this.debug && console.log(`MemoryStore<${this.key}>.queryCounter`, { kind, counter, exact, range });

    const dims = counter.split(":");
    const setKey = `${this.key}${kind == "totals" ? "Totals" : "Counts"}:${counter}`;
    const counterMap = this.counters.get(setKey) || new Map<string, number>();

    const prefix = dims
      .filter((d: string) => typeof exact[d] != "undefined")
      .map((d: string) => `${d}=${exact[d]}`)
      .join(":");

    const hasMore = dims.length > Object.keys(exact).length;

    const minPrefix = range?.min != null ? `${prefix}${prefix ? ":" : ""}${range.field}=${range.min}` : prefix;
    const maxPrefix = range?.max != null ? `${prefix}${prefix ? ":" : ""}${range.field}=${range.max}` : prefix;

    // matches RedisStore's `[`-prefixed (always inclusive) ZRANGEBYLEX bounds, minus the
    // Redis-specific bound-type marker -- comparisons below are plain string comparisons.
    const min = `${minPrefix}${hasMore ? ":\x00" : ""}`;
    const max = `${maxPrefix}${hasMore ? ":\x7f" : ""}`;

    this.debug && console.log(`MemoryStore<${this.key}>.queryCounter`, { setKey, min, max });

    // sorted lexicographically to mirror ZRANGEBYLEX's byte-order member comparison
    const members = Array.from(counterMap.keys()).sort();
    const filtered = members.filter((m) => m >= min && m <= max);

    if (kind == "count") {
      this.debug && console.log(`MemoryStore<${this.key}>.queryCounter`, { count: filtered.length });
      return filtered.length;
    }

    const results = filtered.map((member) => ({ member, score: counterMap.get(member)! }));
    this.debug && console.log(`MemoryStore<${this.key}>.queryCounter`, { results });

    return results;
  }

  async delete(id: string, options?: { hardDelete?: boolean, noLookup?: boolean, lookups?: any }): Promise<T | undefined> {
    this.debug && console.log(`MemoryStore<${this.key}>.delete`, { id, options });

    if (!id) {
      throw `Cannot delete ${this.key}: null id`;
    }

    options = { ...this.options, ...options };
    const value = await this.get(id, { deleted: true });
    if (!value) {
      console.warn(`MemoryStore<${this.key}>.delete WARNING: does not exist: ${id}`);
    }

    const lookupKeys = value && this.lookupKeys(value, options);
    this.debug && console.log(`MemoryStore<${this.key}>.delete`, { lookupKeys });

    const deletedAt = Date.now();

    if (value) {
      if (options?.hardDelete) {
        this.records.delete(id);
      } else {
        this.records.set(id, { ...value, deletedAt });
      }
    }

    this.index.remove(id);
    (lookupKeys || []).forEach(([lookupKey, lookupId]: any) => this.lookups.get(lookupKey)?.remove(lookupId));

    return value ? { ...value, deletedAt } : undefined;
  }
}
