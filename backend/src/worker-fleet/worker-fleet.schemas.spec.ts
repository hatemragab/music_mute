import type { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { JobSchema } from '../jobs/job.schema.js';
import {
  WorkerEnrollmentInvitationSchema,
  WorkerInstallationSessionSchema,
} from './enrollment/worker-enrollment.schema.js';
import { WorkerAttemptSchema } from './jobs/worker-attempt.schema.js';
import { WorkerMachineSchema } from './machines/worker-machine.schema.js';
import { WorkerSlotSchema } from './machines/worker-slot.schema.js';
import { WorkerFleetPolicySchema } from './policy/worker-fleet-policy.schema.js';
import { WorkerDiagnosticSchema } from './telemetry/worker-diagnostic.schema.js';
import { WorkerCommandSchema } from './control/worker-command.schema.js';

function indexNames(schema: Schema): string[] {
  return schema
    .indexes()
    .map(([, options]) => String(options.name))
    .sort();
}

describe('worker fleet persistence contract', () => {
  it('uses strict bounded collections without recoverable credentials', () => {
    const schemas = [
      WorkerEnrollmentInvitationSchema,
      WorkerInstallationSessionSchema,
      WorkerMachineSchema,
      WorkerSlotSchema,
      WorkerAttemptSchema,
      WorkerFleetPolicySchema,
      WorkerDiagnosticSchema,
      WorkerCommandSchema,
    ];
    expect(schemas.every((schema) => schema.get('strict') === 'throw')).toBe(
      true,
    );
    expect(WorkerEnrollmentInvitationSchema.path('code')).toBeUndefined();
    expect(WorkerInstallationSessionSchema.path('credential')).toBeUndefined();
    expect(WorkerMachineSchema.path('credential')).toBeUndefined();
    expect(WorkerEnrollmentInvitationSchema.path('codeDigest')).toBeDefined();
    expect(WorkerMachineSchema.path('credentialDigest')).toBeDefined();
  });

  it('pins identity, claim, lease, lifecycle and expiry indexes', () => {
    expect(indexNames(WorkerEnrollmentInvitationSchema)).toEqual([
      'worker_invitation_digest_unique',
      'worker_invitation_lifecycle',
    ]);
    expect(indexNames(WorkerInstallationSessionSchema)).toEqual([
      'worker_installation_credential_unique',
      'worker_installation_invitation_unique',
      'worker_installation_lifecycle',
    ]);
    expect(indexNames(WorkerMachineSchema)).toEqual([
      'worker_machine_credential_unique',
      'worker_machine_group_status',
      'worker_machine_status_seen',
    ]);
    expect(indexNames(WorkerSlotSchema)).toEqual([
      'worker_slot_current_attempt_unique',
      'worker_slot_identity_unique',
      'worker_slot_machine_state',
    ]);
    expect(indexNames(WorkerAttemptSchema)).toEqual([
      'worker_attempt_claim_request_unique',
      'worker_attempt_job_number_unique',
      'worker_attempt_lease_recovery',
      'worker_attempt_slot_history',
    ]);
    expect(indexNames(WorkerDiagnosticSchema)).toEqual([
      'worker_diagnostic_expiry',
      'worker_diagnostic_installation_sequence_unique',
      'worker_diagnostic_machine_history',
      'worker_diagnostic_machine_sequence_unique',
    ]);
    expect(indexNames(WorkerCommandSchema)).toEqual([
      'worker_command_expiry',
      'worker_command_machine_pending',
    ]);
  });

  it('adds atomic ownership and queue indexes to the existing audio jobs model', () => {
    expect(JobSchema.options.collection).toBe('audio_jobs');
    expect(indexNames(JobSchema)).toEqual(
      expect.arrayContaining([
        'jobs_worker_claim_eligibility',
        'jobs_worker_lease_expiry',
        'jobs_worker_attempt_unique',
      ]),
    );
    expect(JobSchema.path('recipeSnapshot')).toBeDefined();
    expect(JobSchema.path('currentExecution')).toBeDefined();
    expect(JobSchema.path('attemptNumber')).toBeDefined();
  });
});
