describe('NotificationDelivery schema contract', () => {
  it('exports per-binding durable delivery state', async () => {
    const module = await import('./notification-delivery.schema.js').catch(
      () => ({ NotificationDelivery: undefined }),
    );

    expect(module.NotificationDelivery).toBeTypeOf('function');
  });

  it('expires details only on an explicit parent-completion expiry date', async () => {
    const { NotificationDeliverySchema } =
      await import('./notification-delivery.schema.js');
    expect(NotificationDeliverySchema.path('purgeAt').options.default).toBe(
      null,
    );
    expect(NotificationDeliverySchema.indexes()).toContainEqual([
      { purgeAt: 1 },
      {
        expireAfterSeconds: 0,
        partialFilterExpression: {
          status: { $in: ['sent', 'ineligible', 'invalid', 'failed'] },
        },
        name: 'notification_delivery_retention',
      },
    ]);
  });
});
