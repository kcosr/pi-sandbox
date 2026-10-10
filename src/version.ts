import product from "../package.json" with { type: "json" };
import pi from "../pi-source.lock.json" with { type: "json" };

declare const PI_SANDBOX_DISPLAY_VERSION: string;

/** The bundler embeds identity; direct source execution is always marked development. */
export const DISPLAY_VERSION =
  typeof PI_SANDBOX_DISPLAY_VERSION === "undefined"
    ? `${pi.version}+ps.${product.version}.dev.source`
    : PI_SANDBOX_DISPLAY_VERSION;
