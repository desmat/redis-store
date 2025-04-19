/*
    Some useful commands

    keys *
    scan 0 match thing:*
    del thing1 thing2 etc
    json.get things $
    json.get things '$[?((@.deletedAt > 0) == false)]'
    json.get things '$[?((@.deletedAt > 0) == true)]'
    json.get things '$[?(@.createdBy == "UID")]'
    json.get things '$[?(@.content ~= "(?i)lorem")]'
    json.get things '$[?(@.id ~= "(ID1)|(ID2)")]
    json.set thing:UUID '$.foos[5].bar' '{"car": 42}'
    json.set thing:UUID '$.foos[1].bar.car' '42'
    json.get userhaikus '$[?(@.haikuId == "ID" && (@.likedAt > 0) == true)]'
*/

import moment from "moment";
import { uuid } from "@desmat/utils";
import { Redis } from "@upstash/redis";

export type RedisStoreRecord = {
  id: string,
  createdAt: number,
  updatedAt?: number,
  deletedAt?: number,
};

// polyfill Set.intersection
; (function () {
  // @ts-ignore
  if (!Set.prototype.intersection) {
    // @ts-ignore    
    Set.prototype.intersection = function (other: Set<any>) {
      return new Set(Array.from(this).filter((value: any) => other.has(value)));
    }
  }
})();

export default class RedisStore<T extends RedisStoreRecord> {
  redis: Redis;
  key: string;
  setKey: string;
  valueKey: (id: string) => string;
  options: any;
  debug: boolean;

  constructor({
    url,
    token,
    key,
    setKey,
    options,
    debug,
  }: {
    key: string,
    setKey?: string,
    options?: any,
    url?: string,
    token?: string,
    debug?: boolean,
  }) {
    const _url = url || process.env.KV_REST_API_URL;
    const _token = token || process.env.KV_REST_API_TOKEN;

    if (!_url) throw 'Error creating RedisStore: `url` is required: either provide in constructor or via environment variable `KV_REST_API_URL`'
    if (!_token) throw 'Error creating RedisStore: `token` is required: either provide in constructor or via environment variable `KV_REST_API_TOKEN`'

    this.redis = new Redis({
      url: _url,
      token: _token
    });

    this.key = key;
    this.setKey = setKey || key + "s";
    this.valueKey = (id: string) => `${key}:${id}`;
    this.options = options;
    this.debug = !!debug;
  }

  lookupKeys(value: any, options?: any) {
    options = { ...this.options, ...options };
    this.debug && console.log(`RedisStore.lookupKeys<${this.key}>.lookupKeys`, { value, options });

    /* 
      create index and lookup sets based on options.lookups

      given a likedhaiku record: 
      {
        id: 123:456,
        userId: 123,
        haikuId 456,
      }

      and lookups: 
      { 
        user: { userId: "haikuId"},
        haiku: { haikuId: "userId" }
      }
  
      we want indexes:

      likedhaiku:123:456 -> value (JSON, the rest are sorted sets, not handled here)
      likedhaikus -> all likedhaiku id's (ie 123:456, etc, not handled here)
      // NOT SUPPORTED FOR NOW // likedhaikus:users -> all user ids (ie 123, etc) NOTE: this should be a sorted set of user ids with its score as number of haikus liked
      likedhaikus:user:123 -> all likedhaiku id's for the given user (ie 123:456, etc)
      // NOT SUPPORTED FOR NOW // likedhaikus:haikus ->  NOTE: this should be a sorted set of haiku ids with its score as number of users who liked it
      likedhaikus:haiku:456 -> all likedhaiku id's for the given haiku (ie 123:456, etc)

    */

    const lookupKeys = !options?.noLookup && Object
      .entries(options?.lookups || {})
      .map((entry) => {
        const id = value.id;
        const lookupName = entry[0];
        const lookupKey = entry[1];
        // TODO validate and log errors
        // @ts-ignore
        const lookupId = value[lookupKey];
        // foos:bar:123 -> 123:456
        return [`${this.setKey}:${lookupName}:${lookupId}`, id];
      }) || [];

    this.debug && console.log(`RedisStore<${this.key}>.lookupKeys`, { options, lookupKeys });

    return lookupKeys;
  }

  async exists(id: string): Promise<boolean> {
    this.debug && console.log(`RedisStore<${this.key}>.exists`, { id });

    const response = await this.redis.exists(this.valueKey(id));

    this.debug && console.log(`RedisStore<${this.key}>.exists`, { response });

    return response > 0;
  }

  async get(id: string, options?: any): Promise<T | undefined> {
    this.debug && console.log(`RedisStore<${this.key}>.get`, { id });

    const response = (await this.redis.json.get(this.valueKey(id), "$") as any[]);

    this.debug && console.log(`RedisStore<${this.key}>.get`, { response });

    let value: T | undefined;
    if (response && response[0] && !(response[0].deletedAt && !options?.deleted)) {
      value = response[0] as T;
    }

    return value;
  }

  async scan(query: any = {}): Promise<Set<string>> {
    this.debug && console.log(`RedisStore<${this.key}>.scan`, { query });

    !query.count && console.warn(`RedisStore.RedisStore<${this.key}>.find WARNING: scan command with no count provided: setting count at 999`);

    const count = query.count || 999;
    const match = this.valueKey(query.scan);
    let keys = new Set<string>();
    let nextCursor = "0";

    do {
      const ret = await this.redis.scan(nextCursor, { match, type: "json", count: count - keys.size });
      this.debug && console.log(`RedisStore<${this.key}>.scan`, { ret });
      nextCursor = ret[0];
      ret[1].forEach((key: string) => keys.size < count && keys.add(key.substring(key.indexOf(':') + 1)));
    } while (keys.size < count && nextCursor && nextCursor != "0");

    this.debug && console.log(`RedisStore<${this.key}>.scan`, { keys });

    return keys;
  }

  async ids(query: any = {}): Promise<Set<string>> {
    this.debug && console.log(`RedisStore<${this.key}>.ids`, { query });

    if (query.scan) {
      return this.scan(query);
    }

    let count = query.count;
    delete query.count;

    if (typeof (count) != "undefined" && typeof (count) != "number") {
      console.warn(`RedisStore.RedisStore<${this.key}>.id WARNING: query.count is not a number`);
      count = undefined;
    }

    let offset = query.offset;
    delete query.offset;

    if (typeof (offset) != "undefined" && typeof (offset) != "number") {
      console.warn(`RedisStore.RedisStore<${this.key}>.id WARNING: query.offset must be a number`);
      offset = undefined;
    }

    const min = offset || 0;
    const max = min + (count || 0) - 1;

    const queryEntries = query && Object.entries(query);

    // .ids() or .ids({})
    if (!queryEntries?.length) {
      // get all keys via the index set
      return new Set(await this.redis.zrange(`${this.setKey}`, min, max, { rev: true }) as string[]);
    }

    // .ids({ foo: "FOO", bar: "BAR", ... })
    const setOfIds = await Promise.all(
      queryEntries.map(([queryKey, queryVal]: [string, string]) => {
        if (queryVal) {
          // lookup keys via the foos:bar:123 lookup set
          return this.redis.zrange(`${this.setKey}:${queryKey}:${queryVal}`, min, max, { rev: true });
        } else {
          throw `redis.find(query) query must have key and value`;
        }
      })
    );

    // @ts-ignore
    const ids = setOfIds.reduce((prev: Set<any> | undefined, curr: any[]) => new Set(curr).intersection(prev || new Set(curr)), undefined)
    this.debug && console.log(`RedisStore<${this.key}>.ids queried lookup key`, { query, setOfIds, ids });

    return ids;
  }

  async find(query: any = {}): Promise<T[]> {
    this.debug && console.log(`RedisStore<${this.key}>.find`, { query });

    const keys = Array.isArray(query.id)
      ? query.id
        .map((id: string) => id && this.valueKey(id))
        .filter(Boolean)
      : Array.from(await this.ids(query))
        // @ts-ignore
        .map((key: string) => `${this.key}:${key}`);

    if (keys.length > 100) {
      console.warn(`RedisStore.RedisStore<${this.key}>.find WARNING: json.mget more than 100 values`, { keys });
    } else {
      this.debug && console.log(`RedisStore<${this.key}>.find`, { keys });
    }

    // don't mget too many at once otherwise 💥
    const blockSize = 256;
    const blocks = keys && keys.length && Array
      .apply(null, Array(Math.ceil(keys.length / blockSize)))
      .map((v: any, block: number) => (keys || [])
        .slice(blockSize * block, blockSize * (block + 1)));
    this.debug && console.log(`RedisStore<${this.key}>.find`, { blocks });

    const values = blocks && blocks.length > 0
      ? (await Promise.all(
        blocks
          .map(async (keys: string[]) => (await this.redis.json.mget(keys, "$") as any)
            .flat())))
        .flat()
        .filter((value: any) => value && !value.deletedAt)
      : [];

    this.debug && console.log(`RedisStore<${this.key}>.find`, { values });

    return values as T[];
  }

  async create(value: any, options?: any): Promise<T> {
    this.debug && console.log(`RedisStore<${this.key}>.create`, { value, options, this_options: this.options });

    const now = moment().valueOf();
    options = { ...this.options, ...options };

    const createdValue = {
      id: value.id || uuid(),
      createdAt: value.createdAt || now,
      ...value,
    }
    this.debug && console.log(`RedisStore<${this.key}>.create`, { createdValue });

    const lookupKeys = this.lookupKeys(createdValue, options);
    this.debug && console.log(`RedisStore<${this.key}>.create`, { lookupKeys });

    const responses = await Promise.all([
      this.redis.json.set(this.valueKey(createdValue.id), "$", createdValue),
      options.expire && this.redis.expire(this.valueKey(createdValue.id), options.expire),
      !options.noIndex && this.redis.zadd(this.setKey, { score: createdValue.createdAt, member: createdValue.id }),
      ...(lookupKeys ? lookupKeys.map((lookupKey: any) => this.redis.zadd(lookupKey[0], { score: createdValue.createdAt, member: lookupKey[1] })) : []),
    ]);

    this.debug && console.log(`RedisStore<${this.key}>.create`, { responses });

    return createdValue;
  }

  async update(value: any, options?: any): Promise<T> {
    this.debug && console.log(`RedisStore<${this.key}>.update`, { value, options });

    if (!value.id) {
      throw `Cannot update ${this.key}: null id`;
    }

    const prevValue = await this.get(value.id);

    if (!prevValue) {
      throw `Cannot update ${this.key}: does not exist: ${value.id}`;
    }

    const now = moment().valueOf();
    options = { ...this.options, ...options }

    const updatedValue = {
      ...value,
      updatedAt: now,
    };

    // optionally update lookups 

    // @ts-ignore
    const prevLookupKeys = new Map(this.lookupKeys(prevValue, options));
    // @ts-ignore
    const lookupKeys = new Map(this.lookupKeys(updatedValue, options));
    const lookupsToRemove = prevLookupKeys && Array.from(prevLookupKeys)
      .filter(([k, v]: any) => !lookupKeys || lookupKeys.get(k) != v);
    const lookupsToAdd = lookupKeys && Array.from(lookupKeys)
      .filter(([k, v]: any) => !prevLookupKeys || prevLookupKeys.get(k) != v);
    this.debug && console.log(`RedisStore<${this.key}>.update`, { prevLookupKeys, lookupKeys, prevLookupKeyMap: prevLookupKeys, keysToRemove: lookupsToRemove, keysToAdd: lookupsToAdd });

    if (lookupsToRemove && lookupsToRemove.length) {
      this.debug && console.log(`RedisStore<${this.key}>.update deleting previous lookup keys`, { prevLookupKeys });
      const response = await Promise.all([
        ...lookupsToRemove.map((lookupKey: any) => this.redis.zrem(lookupKey[0], lookupKey[1]))
      ]);
      this.debug && console.log(`RedisStore<${this.key}>.update deleted previous lookup keys`, { response });
    }

    const response = await Promise.all([
      this.redis.json.set(this.valueKey(value.id), "$", updatedValue),
      options.expire && this.redis.expire(this.valueKey(value.id), options.expire),
      ...(lookupsToAdd ? lookupsToAdd.map((lookupKey: any) => this.redis.zadd(lookupKey[0], { score: updatedValue.createdAt || updatedValue.updatedAt, member: lookupKey[1] })) : []),
    ]);

    this.debug && console.log(`RedisStore<${this.key}>.update`, { response });

    return updatedValue;
  }

  async delete(id: string, options: any = {}): Promise<T | undefined> {
    this.debug && console.log(`RedisStore<${this.key}>.delete`, { id, options });

    if (!id) {
      throw `Cannot delete ${this.key}: null id`;
    }

    options = { ...this.options, ...options };
    const value = await this.get(id, { deleted: true });
    if (!value) {
      console.warn(`RedisStore<${this.key}>.delete WARNING: does not exist: ${id}`);
    }

    const lookupKeys = value && this.lookupKeys(value, options);
    this.debug && console.log(`RedisStore<${this.key}>.delete`, { lookupKeys });

    const deletedAt = moment().valueOf();
    const response = await Promise.all([
      options.hardDelete
        ? this.redis.json.del(this.valueKey(id), "$")
        : this.redis.json.set(this.valueKey(id), "$.deletedAt", deletedAt),
      this.redis.zrem(this.setKey, id),
      ...(lookupKeys ? lookupKeys.map((lookupKey: any) => this.redis.zrem(lookupKey[0], lookupKey[1])) : []),
    ]);

    this.debug && console.log(`RedisStore<${this.key}>.delete`, { response });

    return value ? { ...value, deletedAt } : undefined;
  }
}
