import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';
import { NotificationType } from '@prisma/client';

/**
 * Email Service
 * Handles sending email notifications using Nodemailer
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;
  private readonly emailEnabled: boolean;

  constructor(private readonly configService: ConfigService) {
    this.emailEnabled = this.configService.get<string>('SMTP_HOST')
      ? true
      : false;

    if (this.emailEnabled) {
      this.initializeTransporter();
    } else {
      this.logger.warn(
        'Email service disabled - SMTP_HOST not configured. This is normal for development.',
      );
    }
  }

  /**
   * Initialize Nodemailer transporter
   */
  private initializeTransporter(): void {
    try {
      this.transporter = nodemailer.createTransport({
        host: this.configService.get<string>('SMTP_HOST', 'smtp.gmail.com'),
        port: this.configService.get<number>('SMTP_PORT', 587),
        secure: this.configService.get<boolean>('SMTP_SECURE', false),
        auth: {
          user: this.configService.get<string>('SMTP_USER'),
          pass: this.configService.get<string>('SMTP_PASS'),
        },
      });

      this.logger.log('Email transporter initialized successfully');
    } catch (error) {
      this.logger.error(
        `Failed to initialize email transporter: ${error.message}`,
      );
      this.transporter = null;
    }
  }

  /**
   * Send email notification
   */
  async sendNotification(
    to: string,
    subject: string,
    message: string,
    type: NotificationType,
    data?: Record<string, any>,
  ): Promise<boolean> {
    if (!this.emailEnabled || !this.transporter) {
      this.logger.warn(
        `Email not configured - would have sent: ${subject} to ${to}`,
      );
      return false;
    }

    try {
      const html = this.generateEmailHTML(subject, message, type, data);
      const fromAddress = this.configService.get<string>(
        'EMAIL_FROM',
        'LDV Bridge <noreply@ldvbridge.com>',
      );

      const info = await this.transporter.sendMail({
        from: fromAddress,
        to,
        subject,
        text: message, // Plain text version
        html, // HTML version
      });

      this.logger.log(`Email sent successfully to ${to}: ${info.messageId}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send email to ${to}: ${error.message}`);
      return false;
    }
  }

  /**
   * Generate HTML email template
   */
  private generateEmailHTML(
    title: string,
    message: string,
    type: NotificationType,
    data?: Record<string, any>,
  ): string {
    const iconMap: Record<NotificationType, string> = {
      REVIEW_ASSIGNED: '📋',
      REVIEW_APPROVED: '✅',
      REVIEW_REJECTED: '❌',
      CHANGE_REQUESTED: '🔄',
      DEPLOYMENT_SUCCESS: '🚀',
      DEPLOYMENT_FAILED: '⚠️',
      COMMENT_ADDED: '💬',
      COMMENT_MENTION: '💬',
      HIGH_RISK_CHANGE_DETECTED: '🚨',
      SYSTEM: 'ℹ️',
    };

    const colorMap: Record<NotificationType, string> = {
      REVIEW_ASSIGNED: '#3b82f6', // blue
      REVIEW_APPROVED: '#10b981', // green
      REVIEW_REJECTED: '#ef4444', // red
      CHANGE_REQUESTED: '#f59e0b', // amber
      DEPLOYMENT_SUCCESS: '#10b981', // green
      DEPLOYMENT_FAILED: '#ef4444', // red
      COMMENT_ADDED: '#8b5cf6', // purple
      COMMENT_MENTION: '#8b5cf6', // purple
      HIGH_RISK_CHANGE_DETECTED: '#dc2626', // bright red for urgency
      SYSTEM: '#6b7280', // gray
    };

    const icon = iconMap[type] || 'ℹ️';
    const color = colorMap[type] || '#6b7280';
    const appUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:3000',
    );

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${title}</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Arial, sans-serif; background-color: #f3f4f6;">
          <table role="presentation" style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 40px 0; text-align: center;">
                <table role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                  <!-- Header -->
                  <tr>
                    <td style="padding: 40px 40px 20px; text-align: center;">
                      <div style="font-size: 48px; margin-bottom: 16px;">${icon}</div>
                      <h1 style="margin: 0; color: ${color}; font-size: 24px; font-weight: 600;">${title}</h1>
                    </td>
                  </tr>
                  
                  <!-- Content -->
                  <tr>
                    <td style="padding: 20px 40px;">
                      <p style="margin: 0 0 20px; color: #374151; font-size: 16px; line-height: 1.5;">
                        ${message}
                      </p>
                      
                      ${
                        data && Object.keys(data).length > 0
                          ? `
                        <div style="background-color: #f9fafb; border-radius: 6px; padding: 16px; margin-top: 20px;">
                          <h3 style="margin: 0 0 12px; color: #111827; font-size: 14px; font-weight: 600;">Details:</h3>
                          <table style="width: 100%; font-size: 14px; color: #6b7280;">
                            ${Object.entries(data)
                              .map(
                                ([key, value]) => `
                              <tr>
                                <td style="padding: 4px 0; font-weight: 500;">${this.formatKey(key)}:</td>
                                <td style="padding: 4px 0; text-align: right;">${value}</td>
                              </tr>
                            `,
                              )
                              .join('')}
                          </table>
                        </div>
                      `
                          : ''
                      }
                    </td>
                  </tr>
                  
                  <!-- Action Button -->
                  <tr>
                    <td style="padding: 20px 40px;">
                      <a href="${appUrl}" style="display: inline-block; padding: 12px 24px; background-color: ${color}; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 14px;">
                        View in Dashboard
                      </a>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="padding: 20px 40px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
                      <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                        This is an automated notification from LDV Bridge.
                        <br>
                        <a href="${appUrl}/settings/notifications" style="color: #3b82f6; text-decoration: none;">Manage notification preferences</a>
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;
  }

  /**
   * Format data key for display
   */
  private formatKey(key: string): string {
    return key
      .replace(/([A-Z])/g, ' $1') // Add space before capital letters
      .replace(/^./, (str) => str.toUpperCase()) // Capitalize first letter
      .trim();
  }

  /**
   * Verify email connection
   */
  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) {
      return false;
    }

    try {
      await this.transporter.verify();
      this.logger.log('Email connection verified successfully');
      return true;
    } catch (error) {
      this.logger.error(
        `Email connection verification failed: ${error.message}`,
      );
      return false;
    }
  }
}
