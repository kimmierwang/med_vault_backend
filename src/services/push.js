import { Expo } from 'expo-server-sdk';
import { config } from '../config.js';
import { DeviceToken } from '../models/index.js';

// Push notifications through the Expo Notifications API (documentation §3.4.3.1).
// The sender can be swapped (tests do this) so nothing is sent to Expo while testing.
let expo;
async function expoSender(messages) {
  expo = expo || new Expo({ accessToken: config.expoAccessToken });
  for (const chunk of expo.chunkPushNotifications(messages)) {
    await expo.sendPushNotificationsAsync(chunk);
  }
}

let sender = expoSender;
export const setPushSender = (fn) => { sender = fn || expoSender; };

export async function sendToUsers(userIds, { title, body, data }) {
  if (!config.pushEnabled) return;
  const tokens = await DeviceToken.find({ userId: { $in: userIds }, enabled: true }).lean();
  const messages = tokens
    .filter((t) => Expo.isExpoPushToken(t.token))
    .map((t) => ({ to: t.token, sound: 'default', title, body, data }));
  if (!messages.length) return;
  try {
    await sender(messages);
  } catch (err) {
    console.error('Push notification failed:', err.message);
  }
}
