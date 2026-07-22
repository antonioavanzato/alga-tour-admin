'use strict';
// Генерация ключей VAPID (Web Push) и JWT_SECRET.
// Запуск: node backend/gen-keys.js
const crypto = require('crypto');

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = ec.publicKey.export({ type: 'spki', format: 'der' });
const rawPub = spki.subarray(spki.length - 65); // несжатая точка P-256
const jwk = ec.privateKey.export({ format: 'jwk' });
const priv = Buffer.from(jwk.d.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

console.log('VAPID_PUBLIC_KEY  =', rawPub.toString('base64url'));
console.log('VAPID_PRIVATE_KEY =', priv.toString('base64url'));
console.log('JWT_SECRET        =', crypto.randomBytes(32).toString('hex'));
