import type { Migration } from "kysely";
import * as m00 from "../../migrations/00_init_db";
import * as m01 from "../../migrations/01_user_preferences";
import * as m02 from "../../migrations/02_add_hlc_columns";
import * as m03 from "../../migrations/03_add_sync_epoch";
import * as m04 from "../../migrations/04_create_projects";
import * as m05 from "../../migrations/05_add_project_startup_command";

export const migrationObjects: Record<string, Migration> = {
  "00_init_db": { up: m00.up, down: m00.down },
  "01_user_preferences": { up: m01.up, down: m01.down },
  "02_add_hlc_columns": { up: m02.up, down: m02.down },
  "03_add_sync_epoch": { up: m03.up, down: m03.down },
  "04_create_projects": { up: m04.up, down: m04.down },
  "05_add_project_startup_command": { up: m05.up, down: m05.down },
};
