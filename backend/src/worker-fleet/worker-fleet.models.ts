import {
  WorkerEnrollmentInvitation,
  WorkerEnrollmentInvitationSchema,
  WorkerInstallationSession,
  WorkerInstallationSessionSchema,
} from './enrollment/worker-enrollment.schema.js';
import {
  WorkerAttempt,
  WorkerAttemptSchema,
} from './jobs/worker-attempt.schema.js';
import {
  WorkerMachine,
  WorkerMachineSchema,
} from './machines/worker-machine.schema.js';
import { WorkerSlot, WorkerSlotSchema } from './machines/worker-slot.schema.js';
import {
  WorkerFleetPolicy,
  WorkerFleetPolicySchema,
} from './policy/worker-fleet-policy.schema.js';
import {
  WorkerDiagnostic,
  WorkerDiagnosticSchema,
} from './telemetry/worker-diagnostic.schema.js';
import {
  WorkerCommand,
  WorkerCommandSchema,
} from './control/worker-command.schema.js';

export const WORKER_FLEET_MODELS = [
  { name: WorkerCommand.name, schema: WorkerCommandSchema },
  {
    name: WorkerEnrollmentInvitation.name,
    schema: WorkerEnrollmentInvitationSchema,
  },
  {
    name: WorkerInstallationSession.name,
    schema: WorkerInstallationSessionSchema,
  },
  { name: WorkerMachine.name, schema: WorkerMachineSchema },
  { name: WorkerSlot.name, schema: WorkerSlotSchema },
  { name: WorkerAttempt.name, schema: WorkerAttemptSchema },
  { name: WorkerFleetPolicy.name, schema: WorkerFleetPolicySchema },
  { name: WorkerDiagnostic.name, schema: WorkerDiagnosticSchema },
];
