import {
  buildNotificationMessage,
  classifyMessagingFailure,
  notificationRetryDelayMs,
} from './notification-dispatcher.service.js';

describe('NotificationDispatcherService', () => {
  it.each([
    [1, 30_000],
    [2, 120_000],
    [3, 300_000],
    [4, 900_000],
    [5, 3_600_000],
    [6, 14_400_000],
    [7, 43_200_000],
  ])('backs off attempt %i by %i ms', (attempts, delay) => {
    expect(notificationRetryDelayMs(attempts)).toBe(delay);
  });

  it('rejects retry scheduling outside the retryable attempt range', () => {
    expect(() => notificationRetryDelayMs(0)).toThrow(RangeError);
    expect(() => notificationRetryDelayMs(8)).toThrow(RangeError);
  });

  it('classifies only known invalid destinations as permanent', () => {
    expect(
      classifyMessagingFailure({
        code: 'messaging/registration-token-not-registered',
      }),
    ).toEqual({ kind: 'invalid_destination', retryAfterMs: null });
    expect(
      classifyMessagingFailure({ code: 'messaging/internal-error' }),
    ).toEqual({ kind: 'transient', retryAfterMs: null });
    expect(classifyMessagingFailure(new Error('secret provider text'))).toEqual(
      { kind: 'transient', retryAfterMs: null },
    );
  });

  it('honors valid Retry-After seconds and HTTP dates without exposing errors', () => {
    const now = new Date('2026-09-09T12:00:00.000Z');
    expect(
      classifyMessagingFailure(
        { response: { headers: { 'retry-after': '240' } } },
        now,
      ),
    ).toEqual({ kind: 'transient', retryAfterMs: 240_000 });
    expect(
      classifyMessagingFailure(
        {
          response: {
            headers: {
              'Retry-After': 'Wed, 09 Sep 2026 13:00:00 GMT',
            },
          },
        },
        now,
      ),
    ).toEqual({ kind: 'transient', retryAfterMs: 3_600_000 });
    expect(
      classifyMessagingFailure(
        {
          response: {
            headers: { 'retry-after': 'https://provider.invalid/error' },
          },
        },
        now,
      ),
    ).toEqual({ kind: 'transient', retryAfterMs: null });
  });

  it.each([
    ['ready', 'Your audio is ready. Open Vocal to listen.'],
    ['failed', 'Audio processing could not finish. Open Vocal for details.'],
  ] as const)(
    'builds a privacy-safe visible %s alert with stable routing',
    (outcome, body) => {
      const target = {
        id: 'registration-id',
        userId: 'user-id',
        installationId: 'd7ea7de6-52e9-4b96-8834-3b517941bdb0',
        token: 'private-token',
        bindingRevision: 4,
      };
      const event = {
        id: 'outbox-id',
        jobId: 'job-id',
        outcome,
        inputName: 'private-recording.mp3',
        downloadUrl: 'https://private.invalid/signed',
        errorMessage: 'private processing diagnostics',
      };
      const message = buildNotificationMessage(target, event);
      const alert = { title: 'Vocal', body };

      expect(message).toEqual({
        token: 'private-token',
        data: {
          type: 'audio_job_outcome',
          jobId: 'job-id',
          eventId: 'outbox-id',
          outcome,
        },
        notification: alert,
        android: {
          priority: 'normal',
          notification: {
            channelId: 'audio_processing_outcomes',
            tag: 'outbox-id',
            sound: 'default',
          },
        },
        apns: {
          headers: {
            'apns-push-type': 'alert',
            'apns-priority': '5',
            'apns-collapse-id': 'outbox-id',
          },
          payload: { aps: { alert, sound: 'default' } },
        },
      });
      const { token: _destination, ...payload } = message as typeof message & {
        token: string;
      };
      expect(JSON.stringify(payload)).not.toMatch(
        /private|https?:|diagnostics|registration-id|user-id/,
      );
      expect(buildNotificationMessage(target, event)).toEqual(message);
    },
  );
});
