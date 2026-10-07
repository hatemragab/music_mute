import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createConnection, Types } from 'mongoose';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { User, UserSchema } from '../dist/users/user.schema.js';
import { Job, JobSchema } from '../dist/jobs/job.schema.js';
import {
  AdminAccess,
  AdminAccessSchema,
} from '../dist/admin/admin-access.schema.js';
import {
  AdminOperation,
  AdminOperationSchema,
} from '../dist/admin/admin-operation.schema.js';
import {
  AdminAuditEvent,
  AdminAuditEventSchema,
} from '../dist/admin/admin-audit.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';
import { permissionsForRole } from '../dist/admin/admin-permissions.js';
import { WORKER_FLEET_MODELS } from '../dist/worker-fleet/worker-fleet.models.js';
import { WorkerEnrollmentService } from '../dist/worker-fleet/enrollment/worker-enrollment.service.js';
import { WorkerControlService } from '../dist/worker-fleet/control/worker-control.service.js';
import { WorkerMachineLifecycleService } from '../dist/worker-fleet/machines/worker-machine-lifecycle.service.js';
import { WorkerAuthGuard } from '../dist/worker-fleet/auth/worker-auth.guard.js';
import {
  WORKER_ROUTE,
  WORKER_CREDENTIAL_KIND,
  WORKER_ALLOW_REVOKED_MACHINE,
} from '../dist/worker-fleet/auth/worker-auth.decorators.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const errorCode = (code) => (error) => error.getResponse().code === code;

// Owned local Mongo transactions only; no real account, worker, GPU or R2.
test(
  'machine deletion fences authority and account approval atomically',
  { timeout: 60_000 },
  async (t) => {
    const services = await IsolatedServices.create();
    t.after(() => services.stop());
    const { mongoUri } = await services.startDatabases({ replicaSet: true });
    const db = await createConnection(mongoUri, {
      bufferCommands: false,
    }).asPromise();
    t.after(() => db.close());
    const definitions = [
      { name: User.name, schema: UserSchema },
      { name: Job.name, schema: JobSchema },
      { name: AdminAccess.name, schema: AdminAccessSchema },
      { name: AdminOperation.name, schema: AdminOperationSchema },
      { name: AdminAuditEvent.name, schema: AdminAuditEventSchema },
      ...WORKER_FLEET_MODELS,
    ];
    const m = Object.fromEntries(
      definitions.map(({ name, schema }) => [name, db.model(name, schema)]),
    );
    await Promise.all(Object.values(m).map((model) => model.init()));
    const audit = new AdminAuditService(m.AdminAuditEvent);
    const operations = new AdminOperationsService(
      db,
      m.AdminAccess,
      m.AdminOperation,
      audit,
    );
    const enrollment = new WorkerEnrollmentService(
      db,
      m.WorkerEnrollmentInvitation,
      m.WorkerInstallationSession,
      m.WorkerMachine,
      m.WorkerAttempt,
      m.Job,
      operations,
      m.User,
      audit,
    );
    const control = new WorkerControlService(
      m.WorkerMachine,
      m.WorkerSlot,
      m.WorkerAttempt,
      m.WorkerFleetPolicy,
      m.WorkerEnrollmentInvitation,
      m.WorkerInstallationSession,
      m.WorkerDiagnostic,
      m.WorkerCommand,
      operations,
    );
    const lifecycle = new WorkerMachineLifecycleService(
      m.WorkerMachine,
      m.WorkerAttempt,
    );
    const actor = {
      uid: 'deletion-owner',
      verifiedEmail: 'owner@fixture.invalid',
      role: 'owner',
      permissions: permissionsForRole('owner'),
      accessRevision: 0,
      authTimeSec: Math.floor(Date.now() / 1000),
    };
    await m.AdminAccess.create({
      uid: actor.uid,
      verifiedEmail: actor.verifiedEmail,
      role: actor.role,
      active: true,
    });
    const now = new Date();
    const user = await m.User.create({
      firebaseUid: 'deletion-user',
      email: 'person@fixture.invalid',
      emailVerified: true,
      displayName: 'Deletion fixture',
      nameSource: 'email_prefix',
      providerIds: ['google.com'],
      profileSyncedAt: now,
      lastSeenAt: now,
      workerRegistrationAllowed: true,
    });
    const userId = user._id.toHexString();
    const credential = randomBytes(32).toString('base64url');
    const machine = await m.WorkerMachine.create({
      _id: randomUUID(),
      label: 'Delete fixture Mac',
      credentialDigest: digest(credential),
      status: 'active',
      registeredByUserId: userId,
    });
    const otherMachine = await m.WorkerMachine.create({
      _id: randomUUID(),
      label: 'Independent Mac',
      credentialDigest: digest(randomBytes(32).toString('base64url')),
      status: 'active',
      registeredByUserId: userId,
    });
    const command = {
      operationId: randomUUID(),
      expectedRevision: 0,
      expectedUserRevision: 0,
      reason: 'Delete fixture registration and disable new enrollment',
    };
    const future = new Date(Date.now() + 300_000);
    // Minimal collection fixtures exercise the existing nested lease write fence.
    const jobId = new Types.ObjectId();
    const attemptId = randomUUID();
    await m.Job.collection.insertOne({
      _id: jobId,
      currentExecution: { machineId: machine._id, leaseExpiresAt: future },
    });
    await m.WorkerAttempt.collection.insertOne({
      _id: attemptId,
      machineId: machine._id,
      state: 'running',
      revision: 0,
      leaseExpiresAt: future,
    });

    await t.test(
      'revision failures preserve both machine and user state',
      async () => {
        await assert.rejects(
          enrollment.deleteMachine(actor, machine._id, {
            ...command,
            operationId: randomUUID(),
            expectedUserRevision: 7,
          }),
          errorCode('REVISION_CONFLICT'),
        );
        assert.equal(
          (await m.User.findById(user._id)).workerRegistrationAllowed,
          true,
        );
        assert.equal(
          (await m.WorkerMachine.findById(machine._id)).deletedAt,
          null,
        );
        assert.equal(
          await m.AdminAuditEvent.countDocuments({ resourceId: machine._id }),
          0,
        );
      },
    );
    await t.test(
      'an audit failure after the account write rolls back the transaction',
      async () => {
        const record = audit.record.bind(audit);
        audit.record = async () => {
          throw new Error('Owned audit fault fixture');
        };
        try {
          await assert.rejects(
            enrollment.deleteMachine(actor, machine._id, {
              ...command,
              operationId: randomUUID(),
            }),
            /Owned audit fault fixture/,
          );
        } finally {
          audit.record = record;
        }
        assert.equal(
          (await m.User.findById(user._id)).workerRegistrationAllowed,
          true,
        );
        assert.equal((await m.User.findById(user._id)).adminRevision, 0);
        assert.equal(
          (await m.WorkerMachine.findById(machine._id)).deletedAt,
          null,
        );
        assert.equal(
          (await m.WorkerAttempt.findById(attemptId)).leaseExpiresAt.getTime(),
          future.getTime(),
        );
      },
    );
    await t.test(
      'deletion hides the machine, expires leases and disables only new account registrations',
      async () => {
        const result = await enrollment.deleteMachine(
          actor,
          machine._id,
          command,
        );
        assert.equal(result.status, 'succeeded');
        assert.equal(result.resourceId, machine._id);
        assert.equal(result.revision, 1);
        const deleted = await m.WorkerMachine.findById(machine._id);
        assert.equal(deleted.status, 'revoked');
        assert.ok(deleted.deletedAt instanceof Date);
        assert.equal(deleted.credentialRevision, 2);
        assert.equal(
          (await m.User.findById(user._id)).workerRegistrationAllowed,
          false,
        );
        assert.equal(
          (await m.WorkerMachine.findById(otherMachine._id)).status,
          'active',
        );
        assert.ok(
          (await m.Job.findById(jobId)).currentExecution.leaseExpiresAt <
            future,
        );
        assert.ok(
          (await m.WorkerAttempt.findById(attemptId)).leaseExpiresAt < future,
        );
        assert.deepEqual(
          (await control.listMachines(actor, { limit: 25 })).items.map(
            (item) => item.machineId,
          ),
          [otherMachine._id],
        );
        await assert.rejects(
          control.machineDetail(actor, machine._id),
          errorCode('RESOURCE_NOT_FOUND'),
        );
        await assert.rejects(
          enrollment.createUserInvitation(userId, {
            uid: user.firebaseUid,
            provider: 'google.com',
            authTimeSec: actor.authTimeSec,
            tokenEmailVerified: true,
          }),
          errorCode('WORKER_REGISTRATION_NOT_ALLOWED'),
        );
        const events = await m.AdminAuditEvent.find({
          operationId: command.operationId,
        }).lean();
        assert.deepEqual(events.map((event) => event.action).sort(), [
          'users.worker_registration.update',
          'workers.machine.delete',
        ]);
      },
    );
    await t.test(
      'operation replay cannot repeat side effects or override a later approval',
      async () => {
        await m.User.updateOne(
          { _id: user._id },
          {
            $set: { workerRegistrationAllowed: true },
            $inc: { adminRevision: 1 },
          },
        );
        const result = await enrollment.deleteMachine(
          actor,
          machine._id,
          command,
        );
        assert.equal(result.status, 'succeeded');
        assert.equal(
          (await m.User.findById(user._id)).workerRegistrationAllowed,
          true,
        );
        assert.equal(
          await m.AdminAuditEvent.countDocuments({
            operationId: command.operationId,
          }),
          2,
        );
        assert.equal((await m.WorkerMachine.findById(machine._id)).revision, 1);
        await assert.rejects(
          enrollment.deleteMachine(actor, machine._id, {
            ...command,
            registrationUserId: new Types.ObjectId().toHexString(),
          }),
          errorCode('REVISION_CONFLICT'),
        );
      },
    );
    await t.test(
      'deleted credentials receive only a typed deletion notice and cleanup confirmation',
      async () => {
        const guard = new WorkerAuthGuard(
          new Reflector(),
          m.WorkerEnrollmentInvitation,
          m.WorkerInstallationSession,
          m.WorkerMachine,
          { reserve: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
          { bucket: (scope, key) => `${scope}:${key}` },
          new ConfigService(),
        );
        const handler = () => {};
        Reflect.defineMetadata(WORKER_ROUTE, true, handler);
        Reflect.defineMetadata(WORKER_CREDENTIAL_KIND, 'machine', handler);
        const authorization = `Bearer ${credential}`;
        const req = {
          headers: { authorization },
          rawHeaders: ['Authorization', authorization],
          ip: '127.0.0.1',
        };
        const context = {
          getHandler: () => handler,
          getClass: () => class Fixture {},
          switchToHttp: () => ({
            getRequest: () => req,
            getResponse: () => ({ setHeader() {} }),
          }),
        };
        await assert.rejects(
          guard.canActivate(context),
          errorCode('WORKER_MACHINE_DELETED'),
        );
        Reflect.defineMetadata(WORKER_ALLOW_REVOKED_MACHINE, true, handler);
        assert.equal(await guard.canActivate(context), true);
        const confirmation = await lifecycle.unpair(req.workerPrincipal);
        assert.equal(confirmation.deleted, true);
        assert.equal(confirmation.confirmed, true);
        assert.equal(confirmation.status, 'revoked');
        assert.equal((await m.WorkerMachine.findById(machine._id)).revision, 1);
      },
    );
    await t.test(
      'legacy deletion needs explicit account selection without assigning provenance',
      async () => {
        const legacy = await m.WorkerMachine.create({
          _id: randomUUID(),
          label: 'Legacy fixture',
          credentialDigest: digest(randomBytes(32).toString('base64url')),
          status: 'revoked',
        });
        const selected = await m.User.findById(user._id);
        await assert.rejects(
          enrollment.deleteMachine(actor, legacy._id, {
            ...command,
            operationId: randomUUID(),
            expectedRevision: 0,
          }),
          errorCode('INVALID_REQUEST'),
        );
        await enrollment.deleteMachine(actor, legacy._id, {
          ...command,
          operationId: randomUUID(),
          expectedRevision: 0,
          registrationUserId: userId,
          expectedUserRevision: selected.adminRevision,
        });
        assert.equal(
          (await m.WorkerMachine.findById(legacy._id)).registeredByUserId,
          null,
        );
        assert.equal(
          (await m.User.findById(user._id)).workerRegistrationAllowed,
          false,
        );
      },
    );
  },
);
