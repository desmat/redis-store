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

export class RedisStore<T extends RedisStoreRecord> {
  redis: Redis;
  key: string;
  setKey: string;
  valueKey: (id: string) => string;
  recordOptions: any;
  debug: boolean;

  constructor({
    url,
    token,
    key,
    setKey,
    recordOptions,
    debug,
  }: {
    url: string,
    token: string,
    key: string,
    setKey?: string,
    recordOptions?: any,
    debug?: boolean,
  }) {
    this.redis = new Redis({ url, token });
    this.key = key;
    this.setKey = setKey || key + "s";
    this.valueKey = (id: string) => `${key}:${id}`;
    this.recordOptions = recordOptions;
    this.debug = !!debug;
  }

  lookupKeys(value: any, options?: any) {
    options = { ...this.recordOptions, ...options };
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

  async get(id: string): Promise<T | undefined> {
    this.debug && console.log(`RedisStore<${this.key}>.get`, { id });

    const response = (await this.redis.json.get(this.valueKey(id), "$") as any[]);

    this.debug && console.log(`RedisStore<${this.key}>.get`, { response });

    let value: T | undefined;
    if (response && response[0] && !response[0].deletedAt) {
      value = response[0] as T;
    }

    return value;
  }

  async scan(query: any = {}): Promise<Set<string>> {
    this.debug && console.log(`RedisStore<${this.key}>.scan`, { query });

    const count = query.count;
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

    const min = query.offset || 0;
    const max = min + (query.count || 0) - 1;
    delete query.offset;
    delete query.count;

    const queryEntries = query && Object.entries(query);

    // TODO: support more than one
    if (queryEntries?.length > 1) {
      throw `redis.find(query) only supports a single query entry pair`;
    }

    let ids = [];
    const queryEntry = queryEntries && queryEntries[0];
    const [queryKey, queryVal] = queryEntry || [];

    if (queryKey == "id" && Array.isArray(queryVal)) {
      this.debug && console.log(`RedisStore<${this.key}>.ids special case: query is for IDs`, { ids: queryVal });
      ids = queryVal;
    } else {
      if (queryKey) {
        /* NOT SUPPORTED FOR NOW
        if (queryVal == "*") {
          // lookup keys via the foos:bars lookup set
          keys = (await this.kv.zrange(`${this.setKey}:${queryKey}s`, 0, -1))
            // @ts-ignore
            .map((key: string) => `${this.key}:${key}`);
        } else */ if (queryVal) {
          // lookup keys via the foos:bar:123 lookup set
          // @ts-ignore
          ids = await this.redis.zrange(`${this.setKey}:${queryKey}:${queryVal}`, min, max, { rev: true });
        } else {
          throw `redis.find(query) query must have key and value`;
        }

        this.debug && console.log(`RedisStore<${this.key}>.ids queried lookup key`, { query, ids });
      } else {
        // get all keys via the index set
        // @ts-ignore
        ids = await this.redis.zrange(`${this.setKey}`, min, max, { rev: true })
      }
    }

    return new Set(ids);
  }

  async find(query: any = {}): Promise<T[]> {
    this.debug && console.log(`RedisStore<${this.key}>.find`, { query });

    const keys = Array.isArray(query.id)
      ? Array.from(await this.ids(query))
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
    const blockSize = 512;
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
    this.debug && console.log(`RedisStore<${this.key}>.create`, { value, options, recordOptions: this.recordOptions });

    const now = moment().valueOf();
    options = { ...this.recordOptions, ...options };

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
    options = { ...this.recordOptions, ...options }

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

  async delete(id: string, options: any = {}): Promise<T> {
    this.debug && console.log(`RedisStore<${this.key}>.delete`, { id, options });

    if (!id) {
      throw `Cannot delete ${this.key}: null id`;
    }

    options = { ...this.recordOptions, ...options };
    const value = await this.get(id)
    if (!value) {
      throw `Cannot update ${this.key}: does not exist: ${id}`;
    }

    const lookupKeys = this.lookupKeys(value, options);
    this.debug && console.log(`RedisStore<${this.key}>.delete`, { lookupKeys });

    value.deletedAt = moment().valueOf();
    const response = await Promise.all([
      options.hardDelete
        ? this.redis.json.del(this.valueKey(id), "$")
        : this.redis.json.set(this.valueKey(id), "$", { ...value, deletedAt: moment().valueOf() }),
      this.redis.zrem(this.setKey, id),
      ...(lookupKeys ? lookupKeys.map((lookupKey: any) => this.redis.zrem(lookupKey[0], lookupKey[1])) : []),
    ]);

    this.debug && console.log(`RedisStore<${this.key}>.delete`, { response });

    return value;
  }
}
