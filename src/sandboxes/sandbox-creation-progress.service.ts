import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';

export interface SandboxCreationProgressEvent {
  sandboxId: string; // Using tempId before sandbox is created
  step: number;
  totalSteps: number;
  status: 'pending' | 'in-progress' | 'completed' | 'error';
  message: string;
  details?: string;
  timestamp: Date;
}

// Steps for PowerApps sandbox creation
export const POWERAPPS_CREATION_STEPS = {
  VALIDATING: { step: 1, message: 'Validating request...' },
  CREATING_ENVIRONMENT: {
    step: 2,
    message: 'Creating development environment...',
  },
  PROVISIONING_DATAVERSE: {
    step: 3,
    message: 'Provisioning Dataverse database...',
  },
  COPYING_APP: { step: 4, message: 'Copying app to new environment...' },
  CREATING_SANDBOX_RECORD: { step: 5, message: 'Creating sandbox record...' },
  CREATING_GITHUB_BRANCH: { step: 6, message: 'Creating GitHub branch...' },
  COMPLETED: { step: 7, message: 'Sandbox created successfully!' },
};

export const TOTAL_POWERAPPS_CREATION_STEPS = 7;

@Injectable()
export class SandboxCreationProgressService {
  private readonly logger = new Logger(SandboxCreationProgressService.name);
  private readonly progressSubject =
    new Subject<SandboxCreationProgressEvent>();

  /**
   * Emit a progress update for a sandbox creation operation
   */
  emitProgress(
    sandboxId: string,
    step: number,
    status: 'pending' | 'in-progress' | 'completed' | 'error',
    message: string,
    details?: string,
  ): void {
    const event: SandboxCreationProgressEvent = {
      sandboxId,
      step,
      totalSteps: TOTAL_POWERAPPS_CREATION_STEPS,
      status,
      message,
      details,
      timestamp: new Date(),
    };

    this.logger.debug(
      `[Creation Progress] ${sandboxId}: Step ${step}/${TOTAL_POWERAPPS_CREATION_STEPS} - ${message}`,
    );

    this.progressSubject.next(event);
  }

  /**
   * Get an observable stream of progress events for a specific sandbox/tempId
   */
  getProgressStream(
    sandboxId: string,
  ): Observable<SandboxCreationProgressEvent> {
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
      POWERAPPS_CREATION_STEPS.COMPLETED.step,
      'completed',
      POWERAPPS_CREATION_STEPS.COMPLETED.message,
      details,
    );
  }
}
