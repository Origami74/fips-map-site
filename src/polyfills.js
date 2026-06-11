// mmdb-lib reads the offline geo database through Node's Buffer API, and its
// metadata module calls Buffer.from() at *module-evaluation* time. ES imports
// are hoisted and run before any sibling statements, so the global must be set
// from a side-effect module that is imported before mmdb-lib's subtree — hence
// this file, imported first in main.js.
import { Buffer } from "buffer";

if (!globalThis.Buffer) globalThis.Buffer = Buffer;
