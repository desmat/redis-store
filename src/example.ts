import RedisStore from "./index";
require('dotenv').config();

type User = {
  id: string,        // required; set by .create as short UUID by default, or can be provided
  createdAt: number, // required; set by .create as tineinmillis
  name: string,
};

type Category = {
  id: string,
  createdAt: number,
  name: string,
};

type Thing = {
  id: string,
  createdAt: number,
  createdBy: string, // needed to lookup Things by Users
  category: string   // needed to lookup Things by Category
  label: string,
};


const ThingOptions = {
  lookups: {
    user: "createdBy",    // enable .find({ user: <USERID> })
    category: "category", // enable .find({ category: <CATEGORYID> })
  },
};

// with environment variables KV_REST_API_URL and KV_REST_API_TOKEN
// or `url` and `token` keys provided to RedisStore constructor
const debug = true;
const store = {
  users: new RedisStore<User>({ key: "example-user", debug }),
  categories: new RedisStore<Category>({ key: "example-category", setKey: "example-categories", debug }),
  things: new RedisStore<Thing>({ key: "example-thing", options: ThingOptions, debug }),
};

async function cleanup() {
  // cleanup all from previous session
  let [
    users,
    categories,
    things,
  ] = await Promise.all([
    store.users.ids({ scan: "*" }),
    store.categories.ids({ scan: "*" }),
    store.things.ids({ scan: "*" }),
  ])
  // console.log("users to delete", { usersToDelete, postsToDelete, userPostsToDelete });
  return Promise.all([
    // @ts-ignore
    ...Array.from(users).map((id: string) => store.users.delete(id, { hardDelete: true })),
    // @ts-ignore
    ...Array.from(categories).map((id: string) => store.categories.delete(id, { hardDelete: true })),
    // @ts-ignore
    ...Array.from(things).map((id: string) => store.things.delete(id, { hardDelete: true })),
  ]);
}

(async function () {
  
  // fully cleanup previous session  
  // await cleanup();


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


  // create categories and things

  const categories = await Promise.all([
    store.categories.create({ id: "category1", name: "Category One" }),
    store.categories.create({ id: "category2", name: "Category Two" }),
  ]);

  const things = await Promise.all([
    store.things.create({
      createdBy: users[0].id,
      category: categories[0].id,
      label: "A thing for user one",
    }),
    store.things.create({
      createdBy: users[0].id,
      category: categories[0].id,
      label: "Another thing for user one",
    }),
    store.things.create({
      createdBy: users[0].id,
      category: categories[1].id,
      label: "Yet another thing for user one",
    }),
    store.things.create({
      createdBy: users[1].id,
      category: categories[1].id,
      label: "A thing for user two",
    }),
  ]);

  // Adding additional sets for lookup:
  // JSON.SET thing:<UUID> $ '{ "id": "<UUID>", "createdAt": <TIMEINMILLIS>, "createdBy": "<USER_UUID>", "categoryId": "<CATEGORY_UUID>", label": "Another thing for user one" }'
  // ZADD things <TIMEINMILLIS> <UUID>
  // ZADD things:user:<USER_UUID> <TIMEINMILLIS> <UUID>
  // ZADD things:category:<CATEGORY_UUID> <TIMEINMILLIS> <UUID>
  // ... 

  console.log("things", things);

  // things (4 entries): [
  //   {
  //     id: '<UUID>',
  //     createdAt: <TIMEINMILLIS>,
  //     createdBy: '<USER_UUID>',
  //     category: `<CATEGORY_UUID>',
  //     label: 'A thing for user one'
  //   },
  //   ...
  // ]


  // all things

  const allThings = await store.things.find();

  // Get thing ids from set of all things then pull their values:
  // ZRANGE	things 0 -1 REV
  // JSON.MGET thing:<THING1_UUID> thing:<THING2_UUID> ...

  console.log("allThings", allThings); // 4 entries


  // latest things from first user

  const latestUserThings = await store.things.find({ user: users[0].id });

  // Get thing ids from set of user lookup things then pull their values:
  // ZRANGE	things:user:<USER_UUID> 0 -1 REV
  // JSON.MGET thing:<THING1_UUID> thing:<THING2_UUID> thing:<THING3_UUID>

  console.log("latestUserThings", latestUserThings); // 3 entries


  // latest things from first user in first category

  const latestUserThingsOfCategory1 = await store.things.find({
    user: users[0].id,
    category: categories[0].id,
  });

  // Get thing ids from both set of user lookup things 
  // and category lookup things, calculate intersection, 
  // then pull their values:
  // ZRANGE	things:user:<USER_UUID> 0 -1 REV
  // ZRANGE	things:category:<CATEGORY_UUID> 0 -1 REV
  // JSON.MGET thing:<THING1_UUID> thing:<THING2_UUID> thing:<THING3_UUID>

  console.log("latestUserThingsOfCategory1", latestUserThingsOfCategory1); // 2 entries


  // cleanup from this session (soft delete by default)

  await Promise.all([
    ...users.map((user: User) => store.users.delete(user.id)),
    ...categories.map((user: User) => store.categories.delete(user.id)),
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
