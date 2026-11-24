// SPDX-License-Identifier: MIT
/**
 * `@efs/sdk/web`: guest-safe browser and worker helpers, with no storage and no write capability. The attempt
 * journal is a write capability, so it lives at `@efs/sdk/web/journal`.
 */

export { streamFile, streamUnverified } from "./stream.js";
