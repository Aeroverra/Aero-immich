import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // workflow runs started by hand on existing assets
  await sql`ALTER TABLE "workflow_log" ADD "isManual" boolean NOT NULL DEFAULT false;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "workflow_log" DROP COLUMN "isManual";`.execute(db);
}
