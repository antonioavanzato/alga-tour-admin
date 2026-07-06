self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch (e) {}
  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || '🔔 Новая заявка ALGA', {
      body: data.body || '', tag: 'alga-booking',
      icon: '../icons/alga-white-logo.png', badge: '../icons/alga-white-logo.png',
    });
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach((c) => c.postMessage({ type: 'alga-push' }));
  })());
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    if (cs[0]) return cs[0].focus();
    return self.clients.openWindow('./');
  }));
});
