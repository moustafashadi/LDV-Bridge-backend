import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { EmailService } from '../email/email.service';
import { NotificationType } from '@prisma/client';

/**
 * Email Processor
 * Processes email notification jobs from the Bull queue
 */
@Processor('notifications')
export class EmailProcessor {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(private readonly emailService: EmailService) {}

  /**
   * Process email sending job
   */
  @Process('send-email')
  async handleSendEmail(
    job: Job<{
      to: string;
      subject: string;
      message: string;
      type: NotificationType;
      data?: Record<string, any>;
    }>,
  ): Promise<void> {
    const { to, subject, message, type, data } = job.data;

    this.logger.log(`Processing email job ${job.id} for ${to}`);

    try {
      const success = await this.emailService.sendNotification(to, subject, message, type, data);

      if (success) {
        this.logger.log(`Email job ${job.id} completed successfully`);
      } else {
        this.logger.warn(`Email job ${job.id} completed but email was not sent (likely not configured)`);
      }
    } catch (error) {
      this.logger.error(`Email job ${job.id} failed: ${error.message}`);
      throw error; // Bull will retry based on configuration
    }
  }
}
