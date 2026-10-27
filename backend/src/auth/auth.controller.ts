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
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto, ResetTokenDto } from './dto/reset-password.dto';
import { ResendVerificationDto, VerifyEmailDto } from './dto/verify-email.dto';
import { EmailVerificationService } from './email-verification.service';
import { PasswordResetService } from './password-reset.service';

@Controller('auth')
export class AuthController {
  private readonly cookieSecure: boolean;

  constructor(
    private readonly authService: AuthService,
    private readonly passwordReset: PasswordResetService,
    private readonly verification: EmailVerificationService,
    config: ConfigService<AuthEnv, true>,
  ) {
    this.cookieSecure = config.get('COOKIE_SECURE', { infer: true });
  }

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.register(dto, sessionMeta(req));
    if ('verificationRequired' in result) return result;
    const { user, ...tokens } = result;
    return { ...this.sendTokens(res, tokens), user };
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { user, ...tokens } = await this.authService.verifyEmail(dto.token, sessionMeta(req));
    return { ...this.sendTokens(res, tokens), user };
  }

  /** The same answer for every address, registered or not. */
  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  resendVerification(@Body() dto: ResendVerificationDto, @Req() req: Request) {
    this.verification.requestResend(dto.email, sessionMeta(req));
    return {
      success: true,
      message: 'If that email has an account waiting to be confirmed, a new link is on its way.',
    };
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
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.changePassword(dto, auth, sessionMeta(req));
    this.clearRefreshCookie(res);
    return { success: true };
  }

  /** The same answer for every address, registered or not. */
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    this.passwordReset.requestReset(dto.email, sessionMeta(req));
    return {
      success: true,
      message: 'If an account exists for that email, a link to reset the password is on its way.',
    };
  }

  /** Lets the reset page say "this link has expired" before the user types a new password. */
  @Public()
  @Post('reset-password/validate')
  @HttpCode(HttpStatus.OK)
  async validateResetToken(@Body() dto: ResetTokenDto) {
    const { expiresAt } = await this.passwordReset.validate(dto.token);
    return { valid: true, expiresAt };
  }

  /** Signs the account out everywhere, this browser included. */
  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.passwordReset.reset(dto, sessionMeta(req));
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
