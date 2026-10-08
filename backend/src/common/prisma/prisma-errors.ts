import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export function rethrowPrismaError(error: unknown, entity: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2025') {
      throw new NotFoundException(`${entity} not found`);
    }

    if (error.code === 'P2002') {
      const target = (error.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
      throw new ConflictException(`${entity} with this ${target} already exists`);
    }
  }

  throw error;
}
