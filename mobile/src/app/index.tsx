// Start: signed in → My Shifts; restaurant known → sign in; otherwise → restaurant address.
import { Redirect } from 'expo-router';

import { useSession } from '@/lib/session';

export default function Index() {
  const { ready, server, token } = useSession();
  if (!ready) return null;
  if (token && server) return <Redirect href="/shifts" />;
  return <Redirect href={server ? '/sign-in' : '/welcome'} />;
}
