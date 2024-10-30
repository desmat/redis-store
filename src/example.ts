import { RedisStore } from "./index";
require('dotenv').config();

type User = {
  id: string,        // required; set by .create as short UUID by default, or can be provided
  createdAt: number, // required; set by .create
  name: string,
};

type Thing = {
  id: string,
  createdAt: number,
  createdBy: string, // needed to lookup Things by Users
  label: string,
};

const ThingOptions = {
  lookups: {
    user: "createdBy", // enable .find({ user: <USERID> })
  },
};

const store = {
  users: new RedisStore<User>({ key: "user" }),
  things: new RedisStore<Thing>({ key: "thing", options: ThingOptions }),
};

(async function () {

  // create users

  const users = await Promise.all([
    store.users.create({ name: "User One" }),
    store.users.create({ name: "User Two" }),
  ]);

  // Redis commands executed:
  // JSON.SET user:<UUID> $ '{ "id": "<UUID>", "createdAt": <TIMEINMILLIS>, "name": "User One" }'
  // ZADD users <TIMEINMILLIS> <UUID>
  // ...

  console.log("users", users);

  // users (2 entries): [
  //   { id: '<UUID>', createdAt: <TIMEINMILLIS>, name: 'User One' },
  //   ...
  // ]


  // create things

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

  // JSON.SET thing:<UUID> $ '{ "id": "<UUID>", "createdAt": <TIMEINMILLIS>, "createdBy": "<USER_UUID>", "message": "Another thing for user one" }'
  // ZADD things <TIMEINMILLIS> <UUID>
  // ZADD things:user:<USER_UUID> <TIMEINMILLIS> <UUID>
  // ... 

  console.log("things", things);

  // things (4 entries): [
  //   {
  //     id: '<UUID>',
  //     createdAt: <TIMEINMILLIS>,
  //     createdBy: '<USER_UUID>',
  //     label: 'A thing for user one'
  //   },
  //   ...
  // ]


  // all things

  const allThings = await store.things.find();

  // ZRANGE	things:user:<USER_UUID> 0 -1 REV
  // JSON.MGET thing:<THING1_UUID> thing:<THING2_UUID> ...

  console.log("allThings", allThings); // 4 entries


  // latest things from first user

  const latestUserThings = await store.things.find({ user: users[0].id });

  // ZRANGE	things:user:<USER_UUID> 0 -1 REV
  // JSON.MGET thing:<THING1_UUID> thing:<THING2_UUID> thing:<THING3_UUID>

  console.log("latestUserThings", latestUserThings); // 3 entries


  // cleanup from this session (soft delete by default)

  await Promise.all([
    ...users.map((user: User) => store.users.delete(user.id)),
    ...things.map((thing: Thing) => store.things.delete(thing.id)),
  ]);

  // JSON.SET user:<UUID> $.deletedAt <TIMEINMILLIS>
  // ZREM users <UUID>
  // ...
  // JSON.SET thing:<UUID> $.deletedAt <TIMEINMILLIS>
  // ZREM things <UUID>
  // ZREM testthings:user:<USER_UUID> <UUID>
  // ...

})();
