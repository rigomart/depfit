import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";

export const db = new DatabaseSync(readFileSync("db.path", "utf8"));
