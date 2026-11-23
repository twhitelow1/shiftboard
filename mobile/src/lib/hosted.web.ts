// The browser version that a ShiftBoard server hosts at /app (npm run build:app, docs/mobile-app/DEVELOPING.md):
// the restaurant is the site it's opened on, so there's no address to type. The Expo web preview on a
// computer (npx expo start --web) isn't under /app and still asks for the address.
export function hostedServer(): string | null {
  const loc = globalThis.location;
  if (!loc || !/^\/app(\/|$)/.test(loc.pathname)) return null;
  return loc.origin.toLowerCase();
}
