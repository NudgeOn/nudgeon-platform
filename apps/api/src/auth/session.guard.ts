import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { SessionService, type SessionMember } from "./session.service";

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
    return true;
  }
}
