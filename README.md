# @desmat/redis-store

[![NPM Version](https://img.shields.io/npm/v/%40desmat%2Fredis-store?link=https%3A%2F%2Fwww.npmjs.com%2Fpackage%2F%40desmat%2Futils)](https://www.npmjs.com/package/@desmat/redis-store)
[![license](https://img.shields.io/npm/l/@desmat/utils?link=LICENSE)](LICENSE)

A lightweight library to facilitate using the (in)famously fast in-memory database as your primary data store for your app’s entities and their relationships.

Leans into Redis’ strong suits to bring relational aspects to the simple but performant KV store:
- Lots of small read/writes
- JSON keys for storing entities (no migration scripts required)
- ZSET keys to track lists and relations

Plays well with Upstash and Vercel but will work with any Redis instance via REST API.


## Installation

Install via npm:

```bash
npm install @desmat/redis-store
```

Or with Yarn:

```bash
yarn add @yourusername/redis-store
```


## Getting Started

Below shows a simple schema with users and things belonging to users, some data added then queried. 

`npm run example` to run [example.ts](./src/example.ts).


### Setup environment variables

```bash
# your .env file, or provided in launch command
KV_REST_API_URL=*****
KV_REST_API_TOKEN=*****
```

*Note: Using Vercel KV environment variables enables this library to be used without friction on Vercel's platform, but `url` and `token` values can be provided in code.*

### Setup entities and store

```typescript
import RedisStore from '@desmat/redis-store';

type User = {
 id: string, // required; set by .create as short UUID by default, or can be provided
 createdAt: number, // required; set by .create
 name: string,
};

type Thing = {
 id: string,
 createdAt: number,
 createdBy: string, // required to lookup Things by Users
 label: string,
};

const ThingOptions = {
 lookups: {
   user: "createdBy", // enables .find({ user: <USERID> })
 },
};

// with environment variables `KV_REST_API_URL` and `KV_REST_API_TOKEN`
// otherwise `url` and `token` can be provided to `RedisStore` constructor
const store = {
 users: new RedisStore<User>({ key: "user" }),
 things: new RedisStore<Thing>({ key: "thing", options: ThingOptions }),
};
```

### Create users and things

```typescript
const users = await Promise.all([
 store.users.create({ name: "User One" }),
 store.users.create({ name: "User Two" }),
]);

// users (2): [
//   { id: '<UUID>', createdAt: <TIMEINMILLIS>, name: 'User One' },
//   ...
// ]

// Redis commands executed:
//
// JSON.SET user:<UUID> $ '{ "id": "<UUID>", "createdAt": <TIMEINMILLIS>, "name": "User One" }'
// ZADD users <TIMEINMILLIS> <UUID>
// ...

const things = await Promise.all([
 store.things.create({
   createdBy: users[0].id,
   label: "A thing for user one",
 }),
 store.things.create({
   createdBy: users[0].id,
   label: "Another thing for user one",
 }),
 store.things.create({
   createdBy: users[0].id,
   label: "Yet another thing for user one",
 }),
 store.things.create({
   createdBy: users[1].id,
   label: "A thing for user two",
 }),
]);

// things (4): [
//   {
//     id: '<UUID>',
//     createdAt: <TIMEINMILLIS>,
//     createdBy: '<USER_UUID>',
//     label: 'A thing for user one'
//   },
//   ...
// ]

// Redis commands executed:
//
// JSON.SET thing:<UUID> $ '{ "id": "<UUID>", "createdAt": <TIMEINMILLIS>, "createdBy": "<USER_UUID>", "message": "Another thing for user one" }'
// ZADD things <TIMEINMILLIS> <UUID>
// ZADD things:user:<USER_UUID> <TIMEINMILLIS> <UUID>
// ...
```

### Query things

```typescript
const allThings = await store.things.find(); // 4 entries

// Redis commands executed:
//
// ZRANGE things:user:<USER_UUID> 0 -1 REV
// JSON.MGET thing:<THING1_UUID> thing:<THING2_UUID> ...

const latestUserThings = await store.things.find({
 user: users[0].id
}); // 3 entries

// Redis commands executed:
//
// ZRANGE things:user:<UUID> 0 -1 REV
// JSON.MGET thing:<THING1_UUID> thing:<THING2_UUID> thing:<THING3_UUID>
```

### Cleanup (soft delete by default)

```typescript
await Promise.all([
 ...users.map((user: User) => store.users.delete(user.id)),
 ...things.map((thing: Thing) => store.things.delete(thing.id)),
]);

// Redis commands executed:
//
// JSON.SET user:<UUID> $.deletedAt <TIMEINMILLIS>
// ZREM users <UUID>
// ...
// JSON.SET thing:<UUID> $.deletedAt <TIMEINMILLIS>
// ZREM things <UUID>
// ZREM testthings:user:<USER_UUID> <UUID>
// ...
```
