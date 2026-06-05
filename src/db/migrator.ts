import "dotenv/config";
import { Cause, Data, Effect, Exit } from "effect";
import { Migrator, type Kysely } from "kysely";
import { ObservabilityLive } from "../lib/server/observability";
import type { Database } from "../types";
import { makeDbLive } from "./kysely";
import { migrationObjects } from "./migrations/migrations-manifest";

class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly cause: unknown;
}> {}

const runMigrations = (
  direction: "up" | "down",
  db: Kysely<Database>,
) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`[Migrator] Running database migrations: direction is ${direction}`);

    const migrator = new Migrator({
      db,
      provider: {
        getMigrations: () => Promise.resolve(migrationObjects),
      },
    });

    const { error, results } = yield* Effect.tryPromise({
      try: () =>
        direction === "up"
          ? migrator.migrateToLatest()
          : migrator.migrateDown(),
      catch: (cause) => new MigrationError({ cause }),
    });

    for (const it of results ?? []) {
      const logEffect = it.status === "Success" ? Effect.logInfo : Effect.logError;
      yield* logEffect(
        `[Migrator] Migration progress - ${it.migrationName}: ${it.status}`
      );
    }

    if (error) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      yield* Effect.logError(`[Migrator] Migration process aborted. Reason: ${errorMessage}`);
      return yield* Effect.fail(error);
    }

    yield* Effect.logInfo("[Migrator] All pending migrations successfully completed.");
  });

const getArgs = (): { direction: "up" | "down" } => {
  const directionArg = Bun.argv[2];
  if (directionArg === "up" || directionArg === "down") {
    return { direction: directionArg };
  }
  return { direction: "up" };
};

const { direction } = getArgs();

const programLogic = Effect.gen(function* () {
  const db = yield* makeDbLive;
  yield* Effect.ensuring(
    runMigrations(direction, db),
    Effect.promise(() => db.destroy()),
  );
});

const runnable = programLogic.pipe(Effect.provide(ObservabilityLive));

void Effect.runPromiseExit(runnable).then((exit) => {
  if (Exit.isFailure(exit)) {
    console.error(`❌ Migration failed:`);
    console.error(Cause.pretty(exit.cause));
    process.exit(1);
  } else {
    console.info(`✅ Migrations processed successfully.`);
    process.exit(0);
  }
});
