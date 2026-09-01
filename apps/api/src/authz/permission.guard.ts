import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { SessionRequest } from "../auth/session.guard";
import { PERMISSION_KEY } from "./require-permission.decorator";
import { can, type Permission } from "./permissions";

/**
 * 인가 가드 (DEV-sub-09 §4). SessionGuard(인증) 다음에 동작.
 * `@RequirePermission()` 미선언 핸들러는 통과(인증만으로 충분) — 민감 컨트롤러에 점진 적용.
 * 서버가 유일한 권한 결정자 — 콘솔 게이팅은 UX 편의일 뿐이다.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      PERMISSION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required) return true; // 권한 미선언 = 인증 통과로 충분

    const req = ctx.switchToHttp().getRequest<SessionRequest>();
    if (!req.member) throw new UnauthorizedException("로그인이 필요합니다");
    if (!can(req.member.role, required)) {
      throw new ForbiddenException(`권한 없음: ${required}`);
    }
    return true;
  }
}
