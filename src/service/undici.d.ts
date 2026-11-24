// Pin the real Undici transport modules: Bun substitutes a native shim for the
// package root. These internal entrypoints avoid both that shim and unrelated
// browser/cache APIs; their signatures use the package's public declarations.
declare module "undici/lib/dispatcher/client.js" {
  import { Client } from "undici";
  export default Client;
}
declare module "undici/lib/api/api-request.js" {
  import type { Client, Dispatcher } from "undici";
  function request(
    this: Client,
    options: Dispatcher.RequestOptions,
  ): Promise<Dispatcher.ResponseData>;
  export default request;
}
