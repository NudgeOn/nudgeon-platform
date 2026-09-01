import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { SessionService, type SessionMember } from "./session.service";

/** 2FA 등록 강제(T-5) 중에도 허용되는 경로 — 등록을 마치기 위한 최소 집합. */
function isEnrollmentAllowed(path: string): boolean {
  return path.startsWith("/v1/auth/totp");
}

export interface SessionRequest extends Request {
  member: SessionMember;
}

/** 콘솔(세션 쿠키) 인증 가드 — 관리 API 전용 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<SessionRequest>();
    const token = (req.cookies?.["onda_session"] as string | undefined) ?? "";
    const member = await this.sessions.resolve(token);
    if (!member) throw new UnauthorizedException("로그인이 필요합니다");
    req.member = member;

    // 2FA 강제(T-5): 테넌트가 필수인데 미등록이면, 등록 경로 외 모든 접근을 차단한다.
    if (member.requires2fa && !member.totpEnabled) {
      const path = (req.path || req.url || "").split("?")[0] ?? "";
      if (!isEnrollmentAllowed(path)) {
        throw new ForbiddenException({
          code: "enrollment_required",
          message: "조직 정책상 2FA 등록이 필요합니다",
        });
      }
    }
    return true;
  }
}
