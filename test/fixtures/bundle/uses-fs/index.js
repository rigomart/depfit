import { readFileSync } from "node:fs";
export const read = (path) => readFileSync(path);
