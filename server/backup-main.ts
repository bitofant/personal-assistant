// Separate entry, not an `import.meta.url === argv[1]` guard: that compare fails via symlinks → silent no-op backup.
import { runBackup } from "./backup.js";

console.log(runBackup());
