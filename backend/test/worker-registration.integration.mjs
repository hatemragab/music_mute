import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createConnection } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { User, UserSchema } from '../dist/users/user.schema.js';
import { Job, JobSchema } from '../dist/jobs/job.schema.js';
import { UsersService } from '../dist/users/users.service.js';
import { presentUser } from '../dist/users/users.presenter.js';
import { AdminUsersService } from '../dist/admin-users/admin-users.service.js';
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
import { WorkerAuthGuard } from '../dist/worker-fleet/auth/worker-auth.guard.js';
import {
  WORKER_CREDENTIAL_KIND,
  WORKER_ROUTE,
} from '../dist/worker-fleet/auth/worker-auth.decorators.js';
import { QUALIFIED_MODEL_DIGEST } from '../dist/jobs/worker-recipes.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const errorCode = (code) => (error) => error.getResponse().code === code;

// Owned loopback Mongo replica set; no installed service, external identity,
// GPU, provider or R2 work. Qualification records below are explicit fixtures.
test(
  'registration permission fences new enrollment while activated machines remain independent',
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
    const models = Object.fromEntries(
      definitions.map(({ name, schema }) => [name, db.model(name, schema)]),
    );
    await Promise.all(Object.values(models).map((model) => model.init()));
    const users = models.User,
      invitations = models.WorkerEnrollmentInvitation;
    const installations = models.WorkerInstallationSession,
      machines = models.WorkerMachine;
    const jobs = models.Job,
      attempts = models.WorkerAttempt;
    const audit = new AdminAuditService(models.AdminAuditEvent);
    const operations = new AdminOperationsService(
      db,
      models.AdminAccess,
      models.AdminOperation,
      audit,
    );
    const enrollment = new WorkerEnrollmentService(
      db,
      invitations,
      installations,
      machines,
      attempts,
      jobs,
      operations,
      users,
    );
    const adminUsers = new AdminUsersService(
      users,
      jobs,
      {},
      {},
      operations,
      {},
      {},
    );
    const userReads = new UsersService(users, {});
    const actor = {
      uid: 'registration-support',
      verifiedEmail: 'support@fixture.invalid',
      role: 'support',
      permissions: permissionsForRole('support'),
      accessRevision: 0,
      authTimeSec: Math.floor(Date.now() / 1000),
    };
    await models.AdminAccess.create({
      uid: actor.uid,
      verifiedEmail: actor.verifiedEmail,
      role: actor.role,
      active: true,
    });
    const now = new Date();
    const user = await users.create({
      firebaseUid: 'registration-user',
      email: 'person@workspace.fixture.invalid',
      emailVerified: true,
      displayName: 'Registration Person',
      nameSource: 'email_prefix',
      providerIds: ['google.com', 'password'],
      profileSyncedAt: now,
      lastSeenAt: now,
    });
    const userId = user._id.toHexString();
    const identity = {
      uid: user.firebaseUid,
      provider: 'google.com',
      authTimeSec: Math.floor(Date.now() / 1000),
      tokenEmailVerified: true,
    };
    const changePermission = async (
      allowed,
      expectedRevision,
      operationId = randomUUID(),
    ) =>
      adminUsers.putWorkerRegistration(actor, userId, {
        workerRegistrationAllowed: allowed,
        expectedRevision,
        operationId,
        reason: 'Review worker registration permission',
      });

    await t.test(
      'missing/default false, audited approval, replay receipts and current Google session',
      async () => {
        await users.collection.updateOne(
          { _id: user._id },
          { $unset: { workerRegistrationAllowed: '' } },
        );
        assert.equal(
          (await adminUsers.detail(userId)).workerRegistrationAllowed,
          false,
        );
        assert.equal(
          presentUser(await users.findById(user._id)).workerRegistrationAllowed,
          false,
        );
        assert.deepEqual(await userReads.workerRegistration(userId), {
          workerRegistrationAllowed: false,
        });
        await assert.rejects(
          enrollment.createUserInvitation(userId, identity),
          errorCode('WORKER_REGISTRATION_NOT_ALLOWED'),
        );
        const operationId = randomUUID();
        const receipt = await changePermission(true, 0, operationId);
        assert.deepEqual(receipt, {
          operationId,
          status: 'succeeded',
          resourceId: userId,
          revision: 1,
        });
        assert.deepEqual(await changePermission(true, 0, operationId), receipt);
        assert.equal((await users.findById(user._id)).adminRevision, 1);
        const record = await models.AdminAuditEvent.findOne({
          operationId,
        }).lean();
        assert.equal(record.actorUid, actor.uid);
        assert.equal(record.reason, 'Review worker registration permission');
        assert.equal(record.previousRevision, 0);
        assert.equal(record.nextRevision, 1);
        assert.equal(record.action, 'users.worker_registration.update');
        await assert.rejects(
          changePermission(false, 0),
          errorCode('REVISION_CONFLICT'),
        );
        await assert.rejects(
          enrollment.createUserInvitation(userId, {
            ...identity,
            provider: 'password',
          }),
          errorCode('GOOGLE_SIGN_IN_REQUIRED'),
        );
        await assert.rejects(
          enrollment.createUserInvitation(userId, {
            ...identity,
            uid: 'another-identity',
          }),
          errorCode('WORKER_REGISTRATION_NOT_ALLOWED'),
        );
      },
    );

    const issue = async () => {
      const issued = await enrollment.createUserInvitation(userId, identity);
      const invitation = await invitations
        .findOne({ codeDigest: digest(issued.credential) })
        .lean();
      assert.equal(invitation.registeredByUserId, userId);
      assert.equal(invitation.createdByUid, identity.uid);
      assert.equal('credential' in invitation, false);
      return { issued, invitation };
    };
    const startInstallation = async ({ issued, invitation }) => {
      const principal = {
        kind: 'enrollment',
        subjectId: invitation._id,
        credential: issued.credential,
      };
      const exchanged = await enrollment.exchange(principal, {
        requestId: randomUUID(),
      });
      const installation = await installations
        .findById(exchanged.installationId)
        .lean();
      assert.equal(installation.registeredByUserId, userId);
      const installationPrincipal = {
        kind: 'installation',
        subjectId: installation._id,
        credential: exchanged.credential,
      };
      await enrollment.report(installationPrincipal, installation._id, {
        requestId: randomUUID(),
        expectedRevision: 0,
        label: 'Fixture Mac',
        summary: 'Synthetic qualified runtime',
        hardware: {
          os: 'Darwin',
          osBuild: 'fixture',
          architecture: 'arm64',
          cpu: 'fixture',
          memoryBytes: 16_000_000_000,
          gpus: [{ id: 'gpu0', name: 'fixture', driverVersion: 'fixture' }],
        },
        runtime: {
          workerVersion: '0.1.3',
          protocolVersion: 1,
          manifestDigest: 'a'.repeat(64),
          modelDigest: QUALIFIED_MODEL_DIGEST,
          providerRuntimeVersion: 'fixture',
        },
        capabilities: [
          {
            platform: 'darwin-arm64',
            provider: 'mps',
            gpuId: 'gpu0',
            recipeIds: ['kim-vocals-v2'],
            maxSlots: 1,
          },
        ],
      });
      await installations.updateOne(
        { _id: installation._id },
        {
          $set: {
            qualificationObject: {
              key: `worker-installation-results/${installation._id}/qualification.mp3`,
              etag: 'fixture',
              bytes: 1234,
              sha256: Buffer.alloc(32, 1).toString('base64'),
              contentType: 'audio/mpeg',
            },
          },
        },
      );
      const credential = randomBytes(32).toString('base64url');
      const activation = {
        requestId: randomUUID(),
        expectedRevision: 1,
        credentialDigest: digest(credential),
      };
      return {
        installationPrincipal,
        installationId: installation._id,
        credential,
        activation,
      };
    };
    const first = await issue(),
      second = await issue();
    assert.notEqual(first.invitation._id, second.invitation._id);
    assert.notEqual(first.issued.credential, second.issued.credential);
    const installed = await startInstallation(first);
    const activated = await enrollment.activate(
      installed.installationPrincipal,
      installed.installationId,
      installed.activation,
    );

    await t.test(
      'one account registers multiple Macs, and removing permission blocks only new exchange/activation',
      async () => {
        const pending = await startInstallation(second);
        const unused = await issue();
        const stored = await machines.findById(activated.machineId).lean();
        assert.equal(stored.registeredByUserId, userId);
        assert.equal(stored.status, 'active');
        await changePermission(false, 1);
        await assert.rejects(
          enrollment.createUserInvitation(userId, identity),
          errorCode('WORKER_REGISTRATION_NOT_ALLOWED'),
        );
        await assert.rejects(
          enrollment.exchange(
            {
              kind: 'enrollment',
              subjectId: unused.invitation._id,
              credential: unused.issued.credential,
            },
            { requestId: randomUUID() },
          ),
          errorCode('WORKER_FORBIDDEN'),
        );
        await assert.rejects(
          enrollment.activate(
            pending.installationPrincipal,
            pending.installationId,
            pending.activation,
          ),
          errorCode('WORKER_FORBIDDEN'),
        );
        assert.equal(
          (await installations.findById(pending.installationId)).phase,
          'reported',
        );
        assert.equal(
          (await machines.findById(activated.machineId)).status,
          'active',
        );
        assert.equal(
          (await machines.findById(activated.machineId)).credentialDigest,
          digest(installed.credential),
        );
        assert.equal(
          (
            await enrollment.activate(
              installed.installationPrincipal,
              installed.installationId,
              installed.activation,
            )
          ).replayed,
          true,
        );
        await changePermission(true, 2);
        const secondMachine = await enrollment.activate(
          pending.installationPrincipal,
          pending.installationId,
          pending.activation,
        );
        assert.notEqual(secondMachine.machineId, activated.machineId);
        assert.equal(
          await machines.countDocuments({ registeredByUserId: userId }),
          2,
        );
      },
    );

    await t.test(
      'permission removal committed during an activation snapshot wins its retry',
      async () => {
        const pending = await startInstallation(await issue());
        let entered, proceed;
        const reachedFence = new Promise((resolve) => {
          entered = resolve;
        });
        const releaseFence = new Promise((resolve) => {
          proceed = resolve;
        });
        const originalUpdate = users.updateOne.bind(users);
        let pauseOnce = true;
        users.updateOne = async (filter, update, options) => {
          if (pauseOnce && update.$inc?.accessRevision === 1) {
            pauseOnce = false;
            entered();
            await releaseFence;
          }
          return originalUpdate(filter, update, options);
        };
        const activation = enrollment.activate(
          pending.installationPrincipal,
          pending.installationId,
          pending.activation,
        );
        // Attach rejection immediately: the concurrent assertion below observes it later.
        const result = activation.then(
          () => null,
          (error) => error,
        );
        try {
          await reachedFence;
          await changePermission(false, 3);
          proceed();
          const error = await result;
          assert.ok(error);
          assert.equal(error.getResponse().code, 'WORKER_FORBIDDEN');
          assert.equal(
            (await installations.findById(pending.installationId)).phase,
            'reported',
          );
          assert.equal(
            await machines.countDocuments({ registeredByUserId: userId }),
            2,
          );
        } finally {
          proceed();
          users.updateOne = originalUpdate;
        }
      },
    );

    await t.test(
      'disabled/deleting/purging accounts cannot change registration permission',
      async () => {
        for (const status of ['disabled', 'deleting', 'purging']) {
          await users.updateOne({ _id: user._id }, { $set: { status } });
          await assert.rejects(
            changePermission(true, 4),
            errorCode('INVALID_REQUEST'),
          );
          await assert.rejects(
            enrollment.createUserInvitation(userId, identity),
            errorCode('WORKER_REGISTRATION_NOT_ALLOWED'),
          );
          assert.equal(
            (await machines.findById(activated.machineId)).status,
            'active',
          );
        }
      },
    );

    await t.test(
      'deleting the registering account leaves machine authentication and activated replay intact',
      async () => {
        await users.deleteOne({ _id: user._id });
        const guard = new WorkerAuthGuard(
          new Reflector(),
          invitations,
          installations,
          machines,
          { reserve: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
          { bucket: (scope, key) => `${scope}:${key}` },
          new ConfigService(),
        );
        const handler = () => {};
        Reflect.defineMetadata(WORKER_ROUTE, true, handler);
        Reflect.defineMetadata(WORKER_CREDENTIAL_KIND, 'machine', handler);
        const authorization = `Bearer ${installed.credential}`;
        const request = {
          headers: { authorization },
          rawHeaders: ['Authorization', authorization],
          ip: '127.0.0.1',
        };
        const context = {
          getHandler: () => handler,
          getClass: () => class Fixture {},
          switchToHttp: () => ({
            getRequest: () => request,
            getResponse: () => ({ setHeader() {} }),
          }),
        };
        assert.equal(await guard.canActivate(context), true);
        assert.equal(request.workerPrincipal.subjectId, activated.machineId);
        assert.equal(
          (
            await enrollment.activate(
              installed.installationPrincipal,
              installed.installationId,
              installed.activation,
            )
          ).replayed,
          true,
        );
        assert.equal(
          (await machines.findById(activated.machineId)).registeredByUserId,
          userId,
        );
      },
    );

    await t.test(
      'legacy admin invitation still exchanges with null user provenance',
      async () => {
        const invitation = await enrollment.createInvitation(
          { ...actor, role: 'owner' },
          {
            operationId: randomUUID(),
            expiresInSeconds: 900,
            reason: 'Fixture legacy enrollment',
          },
        );
        const exchanged = await enrollment.exchange(
          {
            kind: 'enrollment',
            subjectId: invitation.invitationId,
            credential: invitation.credential,
          },
          { requestId: randomUUID() },
        );
        assert.equal(
          (await installations.findById(exchanged.installationId))
            .registeredByUserId,
          null,
        );
      },
    );
  },
);
