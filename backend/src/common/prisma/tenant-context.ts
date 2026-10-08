import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';

/** What the session guard puts on the request; only the organization is read here. */
interface AuthenticatedRequest {
  auth?: { organizationId: string };
}

interface TenantStore {
  organizationId: string;
}

const storage = new AsyncLocalStorage<TenantStore>();

export const TenantContext = {
  run<T>(organizationId: string, fn: () => T): T {
    return storage.run({ organizationId }, fn);
  },

  organizationId(): string | undefined {
    return storage.getStore()?.organizationId;
  },
};

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(
      context: ExecutionContext,
      next: CallHandler,
  ): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request =
        context.switchToHttp().getRequest<AuthenticatedRequest>();

    const organizationId = request.auth?.organizationId;

    if (!organizationId) {
      return next.handle();
    }

    return new Observable((subscriber) =>
        TenantContext.run(
            organizationId,
            () => next.handle().subscribe(subscriber),
        ),
    );
  }
}