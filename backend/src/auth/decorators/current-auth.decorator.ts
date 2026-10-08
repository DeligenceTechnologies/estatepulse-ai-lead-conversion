import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '../auth.types';

export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext =>
    context.switchToHttp().getRequest<Request & { auth: AuthContext }>().auth,
);
