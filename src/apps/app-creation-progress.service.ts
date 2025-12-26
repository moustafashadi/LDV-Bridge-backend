import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';

export interface AppCreationProgressEvent {
  appId: string; // Temporary ID used during creation, then becomes real app ID
  step: number;
  totalSteps: number;
  status: 'pending' | 'in-progress' | 'completed' | 'error';
  message: string;
  details?: string;
  timestamp: Date;
}

export const APP_CREATION_STEPS = {
  INITIALIZING: { step: 1, message: 'Initializing app creation...' },
  CREATING_PROJECT: { step: 2, message: 'Creating Mendix project...' },
  DEPLOYING_APP: { step: 3, message: 'Deploying app to Mendix Cloud...' },
  CREATING_DATABASE: { step: 4, message: 'Creating app record in database...' },
  CREATING_GITHUB_REPO: { step: 5, message: 'Creating GitHub repository...' },
  CLONING_PROJECT: { step: 6, message: 'Cloning project from Team Server...' },
  UPLOADING_GITHUB: { step: 7, message: 'Uploading to GitHub...' },
  FINALIZING: { step: 8, message: 'Finalizing setup...' },
  COMPLETED: { step: 9, message: 'App created successfully!' },
};

export const TOTAL_APP_CREATION_STEPS = 9;

@Injectable()
export class AppCreationProgressService {
  private readonly logger = new Logger(AppCreationProgressService.name);
  private readonly progressSubject = new Subject<AppCreationProgressEvent>();

  /**
   * Emit a progress update for an app creation operation
   */
  emitProgress(
    appId: string,
    step: number,
    status: 'pending' | 'in-progress' | 'completed' | 'error',
    message: string,
    details?: string,
  ): void {
    const event: AppCreationProgressEvent = {
      appId,
      step,
      totalSteps: TOTAL_APP_CREATION_STEPS,
      status,
      message,
      details,
      timestamp: new Date(),
    };

    this.logger.debug(
      `[App Creation Progress] ${appId}: Step ${step}/${TOTAL_APP_CREATION_STEPS} - ${message}`,
    );

    this.progressSubject.next(event);
  }

  /**
   * Get an observable stream of progress events for a specific app creation
   */
  getProgressStream(appId: string): Observable<AppCreationProgressEvent> {
    return this.progressSubject
      .asObservable()
      .pipe(filter((event) => event.appId === appId));
  }

  /**
   * Helper to emit standard step progress
   */
  emitStep(
    appId: string,
    stepConfig: { step: number; message: string },
    status: 'pending' | 'in-progress' | 'completed' | 'error' = 'in-progress',
    details?: string,
  ): void {
    this.emitProgress(
      appId,
      stepConfig.step,
      status,
      stepConfig.message,
      details,
    );
  }

  /**
   * Emit error state
   */
  emitError(
    appId: string,
    step: number,
    message: string,
    error?: string,
  ): void {
    this.emitProgress(appId, step, 'error', message, error);
  }

  /**
   * Emit completion
   */
  emitComplete(appId: string, details?: string): void {
    this.emitProgress(
      appId,
      APP_CREATION_STEPS.COMPLETED.step,
      'completed',
      APP_CREATION_STEPS.COMPLETED.message,
      details,
    );
  }
}
