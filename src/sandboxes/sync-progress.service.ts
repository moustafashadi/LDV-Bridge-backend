import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';

export interface SyncProgressEvent {
  sandboxId: string;
  step: number;
  totalSteps: number;
  status: 'pending' | 'in-progress' | 'completed' | 'error';
  message: string;
  details?: string;
  timestamp: Date;
}

export const SYNC_STEPS = {
  VALIDATING: { step: 1, message: 'Validating sandbox and credentials...' },
  VERIFYING_BRANCH: { step: 2, message: 'Verifying Mendix branch exists...' },
  CLONING_REPO: { step: 3, message: 'Cloning from Mendix Team Server...' },
  PROCESSING_FILES: { step: 4, message: 'Processing project files...' },
  UPLOADING_GITHUB: { step: 5, message: 'Uploading to GitHub...' },
  CREATING_COMMIT: { step: 6, message: 'Creating commit...' },
  DETECTING_CHANGES: { step: 7, message: 'Detecting changes...' },
  COMPLETED: { step: 8, message: 'Sync completed!' },
};

export const TOTAL_SYNC_STEPS = 8;

@Injectable()
export class SyncProgressService {
  private readonly logger = new Logger(SyncProgressService.name);
  private readonly progressSubject = new Subject<SyncProgressEvent>();

  /**
   * Emit a progress update for a sync operation
   */
  emitProgress(
    sandboxId: string,
    step: number,
    status: 'pending' | 'in-progress' | 'completed' | 'error',
    message: string,
    details?: string,
  ): void {
    const event: SyncProgressEvent = {
      sandboxId,
      step,
      totalSteps: TOTAL_SYNC_STEPS,
      status,
      message,
      details,
      timestamp: new Date(),
    };

    this.logger.debug(
      `[Sync Progress] ${sandboxId}: Step ${step}/${TOTAL_SYNC_STEPS} - ${message}`,
    );

    this.progressSubject.next(event);
  }

  /**
   * Get an observable stream of progress events for a specific sandbox
   */
  getProgressStream(sandboxId: string): Observable<SyncProgressEvent> {
    return this.progressSubject
      .asObservable()
      .pipe(filter((event) => event.sandboxId === sandboxId));
  }

  /**
   * Helper to emit standard step progress
   */
  emitStep(
    sandboxId: string,
    stepConfig: { step: number; message: string },
    status: 'pending' | 'in-progress' | 'completed' | 'error' = 'in-progress',
    details?: string,
  ): void {
    this.emitProgress(
      sandboxId,
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
    sandboxId: string,
    step: number,
    message: string,
    error?: string,
  ): void {
    this.emitProgress(sandboxId, step, 'error', message, error);
  }

  /**
   * Emit completion
   */
  emitComplete(sandboxId: string, details?: string): void {
    this.emitProgress(
      sandboxId,
      SYNC_STEPS.COMPLETED.step,
      'completed',
      SYNC_STEPS.COMPLETED.message,
      details,
    );
  }
}
