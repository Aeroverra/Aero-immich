import { Kysely, sql } from 'kysely';

// A stand-in fork migration for the medium tests. Its timestamp sorts before upstream's newest
// migration on purpose: that is the situation every fork migration ends up in after a rebase.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "aero_sample" ("id" integer NOT NULL, CONSTRAINT "aero_sample_pkey" PRIMARY KEY ("id"));`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "aero_sample";`.execute(db);
}
