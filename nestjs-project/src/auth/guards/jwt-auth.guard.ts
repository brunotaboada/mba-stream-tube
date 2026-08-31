import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user: unknown }>();

    // A public route still identifies its caller when a valid token happens to
    // be present, so handlers can vary their response for the owner without
    // requiring authentication. An absent or invalid token is not an error here.
    if (isPublic) {
      await this.attachUserIfPresent(request);
      return true;
    }

    const token = this.extractToken(request.headers?.authorization);
    if (!token) {
      throw new UnauthorizedException();
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }

  private extractToken(authHeader: string | undefined): string | null {
    if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) return null;
    return authHeader.slice(BEARER_PREFIX.length);
  }

  private async attachUserIfPresent(request: {
    headers: Record<string, string>;
    user: unknown;
  }): Promise<void> {
    const token = this.extractToken(request.headers?.authorization);
    if (!token) return;

    try {
      request.user = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      // Anonymous access is legitimate on a public route.
    }
  }
}
