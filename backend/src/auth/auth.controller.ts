import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import type { AuthEnv } from '@/common/utils/interface';
import { REFRESH_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE_PATH } from './auth.constants';
import { AuthService } from './auth.service';
import type { AuthContext, IssuedTokens, SessionMeta } from './auth.types';
import { CurrentAuth } from './decorators/current-auth.decorator';
import { Public } from './decorators/public.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  private readonly cookieSecure: boolean;

  constructor(
    private readonly authService: AuthService,
    config: ConfigService<AuthEnv, true>,
  ) {
    this.cookieSecure = config.get('COOKIE_SECURE', { infer: true });
  }

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { user, ...tokens } = await this.authService.register(dto, sessionMeta(req));
    return { ...this.sendTokens(res, tokens), user };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { user, ...tokens } = await this.authService.login(dto, sessionMeta(req));
    return { ...this.sendTokens(res, tokens), user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies?.[REFRESH_TOKEN_COOKIE] as string | undefined) ?? dto.refreshToken;
    try {
      return this.sendTokens(res, await this.authService.refreshToken(token));
    } catch (error) {
      if (!(error instanceof HttpException && error.getStatus() === HttpStatus.CONFLICT)) {
        this.clearRefreshCookie(res);
      }
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(auth);
    this.clearRefreshCookie(res);
    return { success: true };
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  async logoutAll(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.authService.logoutAll(auth);
    this.clearRefreshCookie(res);
    return { success: true };
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentAuth() auth: AuthContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.changePassword(dto, auth);
    this.clearRefreshCookie(res);
    return { success: true };
  }

  @Get('me')
  me(@CurrentAuth() auth: AuthContext) {
    return this.authService.me(auth);
  }

  /** Sets the refresh cookie and returns what the client may keep in memory. */
  private sendTokens(res: Response, tokens: IssuedTokens) {
    res.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
      ...this.cookieOptions(),
      // Without "keep me signed in" it is a browser-session cookie.
      ...(tokens.keepSignedIn ? { expires: tokens.refreshTokenExpiresAt } : {}),
    });
    return {
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    };
  }

  private clearRefreshCookie(res: Response) {
    res.clearCookie(REFRESH_TOKEN_COOKIE, this.cookieOptions());
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: this.cookieSecure ? 'none' : 'lax',
      path: REFRESH_TOKEN_COOKIE_PATH,
    };
  }
}

function sessionMeta(req: Request): SessionMeta {
  return { userAgent: req.get('user-agent'), ipAddress: req.ip };
}
