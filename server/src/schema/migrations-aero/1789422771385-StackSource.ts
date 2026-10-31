import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TYPE "stack_source_enum" AS ENUM ('manual','auto');`.execute(db);
  await sql`ALTER TABLE "stack" ADD "source" stack_source_enum NOT NULL DEFAULT 'manual';`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "stack" DROP COLUMN "source";`.execute(db);
  await sql`DROP TYPE "stack_source_enum";`.execute(db);
}
