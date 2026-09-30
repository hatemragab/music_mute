describe('NotificationOutbox schema contract', () => {
  it('exports the durable terminal-outcome model', async () => {
    const module = await import('./notification-outbox.schema.js').catch(
      () => ({ NotificationOutbox: undefined }),
    );

    expect(module.NotificationOutbox).toBeTypeOf('function');
  });

  it('keeps the outcome replay fence after delivery details expire', async () => {
    const { NotificationOutboxSchema } =
      await import('./notification-outbox.schema.js');
    expect(
      NotificationOutboxSchema.indexes().some(
        ([, options]) => options.expireAfterSeconds !== undefined,
      ),
    ).toBe(false);
    expect(NotificationOutboxSchema.indexes()).toContainEqual([
      { jobId: 1, outcome: 1 },
      { unique: true, name: 'notification_outbox_job_outcome_unique' },
    ]);
  });
});
