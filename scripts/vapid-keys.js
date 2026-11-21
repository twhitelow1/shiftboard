// Make a VAPID key pair for phone notifications (Web Push):
//   node scripts/vapid-keys.js
// Paste the three lines into Vercel → Settings → Environment Variables (mark the private key
// Sensitive), then redeploy. Keep the same keys afterwards: new keys sign everyone out of phone
// notifications, and they'd have to turn them on again.
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:you@yourrestaurant.com   # a real address of yours, or your site’s https:// URL');
