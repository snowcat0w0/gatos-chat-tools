import { mod } from "./constants.js";
import { createSocket } from "./lib.js";

/**
 * The module's socket relay (gatos-lib createSocket on `module.gatos-chat-tools`; module.json has "socket": true).
 * Handlers are registered by the features that use it; `socket.init()` runs once in `ready` (module.js).
 * Handlers receive the sender as the server-supplied User, never from the payload.
 */
export const socket = createSocket(mod);
