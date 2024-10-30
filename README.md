# redis-store
A lightweight wrapper for using Redis as a data store

## To build
```
npm run build
```

## Example
File `./src/example.ts` demonstrates simple use of this library.

### To run:

Create `.env` file with:
```
KV_REST_API_URL=*****
KV_REST_API_TOKEN=****
```
*Note: Using Vercel KV environment variables enables this library to be used without friction on Vercel's platform, but can be overwritten programmatically.*

then:
```
npm run example
```

### Or alternatively:

```
export KV_REST_API_URL=***** KV_REST_API_TOKEN=***** && npm run example
```
