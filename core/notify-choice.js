// The manager's "Notify staff" choice on a schedule change (Unpublish now; Publish can share it).
// On unless the call says notify: false. It only covers the notice about the schedule itself: messages
// about something that happened to a person's own request (a trade or pickup cancelled) always go out.

/** Did the manager leave "Notify staff" on? (args.notify === false turns it off; anything else is on.) */
export const wantsNotify = (args) => args?.notify !== false;

/**
 * notify() for a schedule notice, following the manager's choice. The returned function takes
 * (userIds, text, link) like notify() and returns how many people were told (0 when the choice is off).
 */
export function staffNotifier(notify, args) {
  const on = wantsNotify(args);
  return (userIds, text, link = '') => {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!on || !ids.length) return 0;
    notify(ids, text, link);
    return ids.length;
  };
}
