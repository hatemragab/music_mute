describe('NotificationDelivery schema contract', () => {
  it('exports per-binding durable delivery state', async () => {
    const module = await import('./notification-delivery.schema.js').catch(
      () => ({ NotificationDelivery: undefined }),
    );

    expect(module.NotificationDelivery).toBeTypeOf('function');
  });
});
