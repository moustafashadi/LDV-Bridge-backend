import { Module } from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { CommentsService } from './comments.service';
import { ReviewsController } from './reviews.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [ReviewsController],
  providers: [ReviewsService, CommentsService],
  exports: [ReviewsService, CommentsService],
})
export class ReviewsModule {}
