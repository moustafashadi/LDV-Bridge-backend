import { Module, Global } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global Prisma Module
 * Provides PrismaService to all modules without needing to import
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
