// Addresses that can't receive mail: demo data, placeholders, reserved test domains.
// Shared by the server (before sending) and the UI (to show who can get an invite).
const UNDELIVERABLE = /@(demo\.shiftboard|example\.(com|org|net))$|\.(test|invalid|example|localhost)$/i;
export const deliverable = (email) => !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !UNDELIVERABLE.test(email);
