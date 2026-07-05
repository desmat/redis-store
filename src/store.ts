import type { RedisStoreRecord } from "./index";

export interface Store<T extends RedisStoreRecord> {
  key: string;
  setKey: string;
  options: any;
  debug: boolean;

  exists(id: string): Promise<boolean>;
  get(id: string, options?: any): Promise<T | undefined>;
  scan(query?: any): Promise<Set<string>>;
  ids(query?: any): Promise<Set<string>>;
  find(query?: any): Promise<T[]>;
  create(value: any, options?: { expire?: number, noIndex?: boolean, score?: number, noLookup?: boolean, lookups?: any }): Promise<T>;
  update(value: any, options?: any): Promise<T>;
  incCounters(values: Record<string, string | number>, delta: { total: number, count: number }): Promise<any>;
  queryCounter(
    kind: "count" | "counts" | "totals",
    counter: string,
    exact: Record<string, string | number>,
    range?: { field: string, min?: string, max?: string }
  ): Promise<number | Array<{ member: string, score: number }>>;
  delete(id: string, options?: { hardDelete?: boolean, noLookup?: boolean, lookups?: any }): Promise<T | undefined>;
}
