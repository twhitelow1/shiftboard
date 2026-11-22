// Time Off as a screen with a back button, for restaurants with Training (then the fourth tab is Training).
// My Shifts, More, the floor screen and time-off notifications open it (src/navigation.ts timeOffRoute).
import { TimeOffView } from '@/components/TimeOffView';

export default function MyTimeOff() {
  return <TimeOffView />;
}
