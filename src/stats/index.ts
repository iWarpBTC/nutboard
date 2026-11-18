import type { Db, SchemaInfo } from "../db.ts";
import { createCdkStats } from "./cdk.ts";
import { createNutshellStats } from "./nutshell.ts";
import type { MintStats } from "./shared.ts";

export * from "./shared.ts";

/** Picks the dialect that matches the tables found in the database. */
export function createStats(db: Db, schema: SchemaInfo): Promise<MintStats> {
  return schema.kind === "cdk" ? createCdkStats(db, schema) : createNutshellStats(db, schema);
}
