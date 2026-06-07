import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { Argon2id } from "oslo/password";
import { randomUUID } from "node:crypto";
import type { Database, UserId } from "../../../src/types/index.ts";
import { ROLE_PERMISSIONS } from "../../../src/lib/shared/permissions.ts";

const connectionString =
  process.env.DATABASE_URL_TEST ||
  process.env.DATABASE_URL_LOCAL ||
  process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("No database connection string found.");
}

const pool = new Pool({
  connectionString,
});

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});

export const createVerifiedSubscriber = async () => {
  const email = `learner-${randomUUID()}@test.com`;
  const password = "Password123!";
  const userId = randomUUID() as UserId;

  const argon2id = new Argon2id();
  const hashedPassword = await argon2id.hash(password);

  await db.insertInto("user").values({
    id: userId,
    email,
    password_hash: hashedPassword,
    email_verified: true,
    permissions: [...ROLE_PERMISSIONS.SUBSCRIBER], 
    created_at: new Date(),
    updated_at: new Date(),
    avatar_url: null
  }).execute();

  return { email, password, userId };
};

export const createCuratorUser = async () => {
  const email = `curator-${randomUUID()}@test.com`;
  const password = "Password123!";
  const userId = randomUUID() as UserId;

  const argon2id = new Argon2id();
  const hashedPassword = await argon2id.hash(password);

  await db.insertInto("user").values({
    id: userId,
    email,
    password_hash: hashedPassword,
    email_verified: true,
    permissions: [...ROLE_PERMISSIONS.CURATOR], 
    created_at: new Date(),
    updated_at: new Date(),
    avatar_url: null
  }).execute();

  return { email, password, userId };
};

export const cleanupTestUser = async (data: { userId?: string }) => {
  if (data.userId) {
    await db.deleteFrom("user").where("id", "=", data.userId as UserId).execute();
  }
};

export const getTestConnectionString = () => connectionString;

export const createTestProject = async (name: string, rootPath: string) => {
  const projectId = randomUUID() as any;
  await db.insertInto("project").values({
    id: projectId,
    name,
    root_path: rootPath,
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
  return projectId;
};

export const deleteTestProject = async (projectId: string) => {
  await db.deleteFrom("project").where("id", "=", projectId as any).execute();
};
