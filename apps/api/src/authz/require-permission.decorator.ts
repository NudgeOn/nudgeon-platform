import { SetMetadata } from "@nestjs/common";
import type { Permission } from "./permissions";

/** 핸들러/컨트롤러가 요구하는 권한을 선언 (DEV-sub-09 §4). */
export const PERMISSION_KEY = "onda:required_permission";

export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);
