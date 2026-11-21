// Signed-out screens: restaurant address, sign in, forgot password.
import { Redirect, Stack } from 'expo-router';

import { useSession } from '@/lib/session';

export default function AuthLayout() {
  const { token, server, colors } = useSession();
  if (token && server) return <Redirect href="/shifts" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
