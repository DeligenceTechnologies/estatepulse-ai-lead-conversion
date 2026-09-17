import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/auth.decorators';
import { SessionGuard } from '../common/guards/session.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';
import { loginSchema, signupSchema, type LoginInput, type SignupInput } from './schemas';
import type { AuthContext, AuthSessionDTO, MeDTO } from './types';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  signup(
    @Body(new ZodValidationPipe(signupSchema, 'Invalid signup details')) body: SignupInput,
  ): Promise<AuthSessionDTO> {
    return this.auth.signup(body);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(
    @Body(new ZodValidationPipe(loginSchema, 'Invalid login details')) body: LoginInput,
  ): Promise<AuthSessionDTO> {
    return this.auth.login(body);
  }

  /** Returns no token: /me never refreshes or reissues a session. */
  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() auth: AuthContext): MeDTO {
    return {
      user: auth.user,
      organization: auth.organization,
      role: auth.role,
      agentProfileId: auth.agentProfileId,
    };
  }
}
