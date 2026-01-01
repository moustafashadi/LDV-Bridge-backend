import { Module, forwardRef } from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { CommentsService } from './comments.service';
import { ReviewsController } from './reviews.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { GitHubModule } from '../github/github.module';
import { SandboxesModule } from '../sandboxes/sandboxes.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    forwardRef(() => GitHubModule),
    forwardRef(() => SandboxesModule),
  ],
  controllers: [ReviewsController],
  providers: [ReviewsService, CommentsService],
  exports: [ReviewsService, CommentsService],
})
export class ReviewsModule {}
