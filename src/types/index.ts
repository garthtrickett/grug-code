// This file bridges Kanel-generated types to the rest of the application.
// The database is the single source of truth; run "bun run db:generate" to regenerate these.
export type { default as Database } from "./generated/Database";
export type { default as UserTable, User, NewUser, UserUpdate, UserId } from "./generated/public/User";
export type { default as PlatformAdminTable, PlatformAdmin, NewPlatformAdmin, PlatformAdminUpdate, PlatformAdminId } from "./generated/public/PlatformAdmin";
export type { default as UserPreferenceTable, UserPreference, NewUserPreference, UserPreferenceUpdate } from "./generated/public/UserPreference";
export type { default as SyncEpochTable, SyncEpoch, NewSyncEpoch, SyncEpochUpdate, SyncEpochId } from "./generated/public/SyncEpoch";
export type { default as ProjectTable, Project, NewProject, ProjectUpdate, ProjectId } from "./generated/public/Project";
