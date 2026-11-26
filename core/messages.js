// What ShiftBoard writes on the server, in English and Spanish: notifications (also sent as email,
// web push, phone app push and texts), the conflict warnings on shifts, emails and text messages.
// Spanish: neutral Latin American, "tú" (docs/i18n/GLOSSARY.md). Restaurant data in the arguments
// (names, positions, areas, notes) is passed through as written.
//
// Each entry takes plain arguments; dates and shift descriptions are already in the right language.
// Use with notify(ids, (lang) => MSG[lang].newShift(describe(s, lang)), link) or the say() helper in
// core/service.js. Keep the English exactly as it was: tests and people's habits depend on it.

const s = (n, one, other) => (n === 1 ? one : other);

export const MSG = {
  en: {
    // ----- schedule -----
    newShift: (shift) => `New shift: ${shift}`,
    shiftChanged: (shift) => `Your shift changed: ${shift}`,
    addedTo: (shift) => `You were added to ${shift}`,
    removedFrom: (shift) => `You were removed from ${shift}`,
    shiftRemoved: (shift) => `Shift removed: ${shift}`,
    weekCleared: (date) => `Your shifts for the week of ${date} were taken off the schedule. A new schedule is coming.`,
    schedulePosted: (from, to) => `The schedule for ${from} – ${to} is posted. Check your shifts.`,
    eventShiftsPosted: (event) => `Event shifts posted for ${event}. Check your shifts.`,
    openShiftsPosted: (n) => `${n} open shift${s(n, '', 's')} available to pick up.`,
    // ----- unpublish (core/unpublish.js) -----
    schedulePulledBack: (from, to, scope, note, by) => `The schedule for ${from} – ${to}${scope ? ` (${scope})` : ''} was pulled back for changes. You'll be notified when it's posted again.${note ? ` Note from ${by}: “${note}”` : ''}`,
    reasonPulledBack: 'the schedule was pulled back for changes',
    republishedChanges: (from, to, changes) => `The schedule for ${from} – ${to} is posted again. What changed for you: ${changes}`,
    republishedSame: (from, to) => `The schedule for ${from} – ${to} is posted again. Your shifts didn't change.`,
    changeAdded: (shift) => `added ${shift}`,
    changeRemoved: (shift) => `removed ${shift}`,
    changeMoved: (shift, to) => `moved ${shift} → ${to}`,
    // ----- trades -----
    requestCancelled: (reason) => `Request cancelled: ${reason}`,
    reasonChanged: 'the shift was changed by a manager',
    reasonRemoved: 'the shift was removed',
    reasonEventRemoved: 'the event was removed',
    requestFilled: (shift) => `Your request for ${shift} was closed — it was filled.`,
    wantsPickup: (name, shift) => `${name} wants to pick up ${shift}`,
    givingAway: (name, shift) => `${name} is giving away ${shift} — pick it up?`,
    wantsTrade: (name, mine, yours) => `${name} wants to trade their ${mine} for your ${yours}`,
    tookYourShift: (name, shift) => `${name} took your ${shift}. It's official.`,
    acceptedTrade: (name) => `${name} accepted your trade — waiting on manager approval.`,
    acceptedShift: (name) => `${name} accepted your shift — waiting on manager approval.`,
    approvalNeeded: (type, shift, from, to) => `Approval needed: ${type === 'swap' ? 'trade' : 'giveaway'} of ${shift} (${from} → ${to})`,
    declinedTrade: (name) => `${name} declined your trade request.`,
    cancelledRequest: (name) => `${name} cancelled the request.`,
    approved: (type, shift) => `Approved: ${type === 'swap' ? 'trade' : type === 'pickup' ? 'pickup' : 'giveaway'} of ${shift}. Check your updated schedule.`,
    denied: (shift, note) => `Denied: request for ${shift}${note ? ` — ${note}` : ''}`,
    // ----- time off -----
    requestedOff: (name, from, to) => `${name} requested off ${from}${to ? ` – ${to}` : ''}`,
    timeOffDecided: (status, from, to) => `Time off ${from}${to ? ` – ${to}` : ''} was ${status}.`,
    // ----- events -----
    beoUpdated: (event, date) => `BEO updated: ${event} (${date}). Review the latest details.`,
    newEvent: (event, date, guests) => `New event: ${event} on ${date} — ${guests} guests`,
    eventCancelled: 'An event you were scheduled for was cancelled.',
    eventComment: (name, event, text) => `${name} on ${event}: “${text}”`,
    // ----- events from Tripleseat (core/tripleseat.js) -----
    tsBeoChanged: (event, date, what) => `BEO updated from Tripleseat: ${event} (${date}). ${what}. Review the latest details.`,
    tsWhatDate: (date) => `New date: ${date}`,
    tsWhatTime: (time) => `New time: ${time}`,
    tsWhatGuests: (n) => `${n} guest${s(n, '', 's')}`,
    tsWhatRoom: (room) => `Room: ${room}`,
    tsCancelledStaffed: (event, date, n) => `${event} (${date}) was cancelled or taken off in Tripleseat, but ${n} ${s(n, 'person is', 'people are')} still scheduled for it. Review the event.`,
    tsMovedStaffed: (event, date, n) => `${event} moved to ${date} in Tripleseat. ${n} ${s(n, 'person’s shift is', 'people’s shifts are')} still on the old day. Review the event.`,
    // ----- people -----
    roleNow: (role) => `Your role is now ${role}.`,
    deletionRequested: (name) => `${name} asked to delete their ShiftBoard account. Remove their sign-in and personal details in Team.`,
    // ----- tips -----
    tipsFinal: (period, amount) => `Your tips for ${period} are final: ${amount}. Tap to see how it was worked out.`,
    tipsReopened: (period) => `Your tips for ${period} were reopened and may change. You’ll be told again when they’re final.`,
    // ----- shift words -----
    openShift: 'Open shift',
    shift: 'Shift',
    untilClose: '',
    forecastNote: (daypart, covers) => `Forecast: ${daypart} (${covers} covers)`,
    // ----- conflicts (warnings on a shift for one person) -----
    conflict: {
      unknown: 'Unknown employee',
      inactive: (name) => `${name} is inactive`,
      untrained: (name, job) => `${name} isn't trained as ${job}`,
      overlap: (shift) => `Overlaps ${shift}`,
      timeOffApproved: 'Approved time off',
      timeOffPending: 'Time-off request pending',
      unavailable: 'Marked unavailable this day',
      availableFrom: (time) => `Available from ${time}`,
      availableUntil: (time) => `Available until ${time}`,
      overtime: (hrs) => `Overtime: ${hrs} hrs this week`,
    },
    // ----- phone notifications and texts (server/channels.js, core/notify-prefs.js) -----
    more: (n) => ` (+${n} more)`,
    pushTest: 'Test: phone notifications are working.',
    smsTest: (restaurant) => `${restaurant}: Test text from ShiftBoard. Texts are working. Reply STOP to opt out.`,
    // The welcome text on someone's first opt-in is in core/consent.js (WELCOME_TEXT): its exact words matter.
    // ----- emails (server/email.js) -----
    email: {
      hi: (first) => `Hi ${first},`,
      there: 'there',
      open: 'Open ShiftBoard',
      notificationFooter: 'You get these emails for updates in ShiftBoard. To stop them, open My Shifts and turn off email notifications.',
      inviteHeading: (restaurant) => `You're on the ${restaurant} schedule`,
      inviteBody: (restaurant, invitedBy) => `${invitedBy ? `${invitedBy} added` : 'You were added'} you to ShiftBoard, where ${restaurant} posts the schedule, shift trades, time off and event details.`,
      inviteSetPassword: 'Set up your account: choose a password, secure your sign-in and add your photo. This link works for 7 days and can be used once.',
      inviteButton: 'Set up my account',
      inviteFooter: (email) => `Your sign-in email is ${email}. If you weren't expecting this, you can ignore it.`,
      inviteSubject: (restaurant) => `Set up your ${restaurant} schedule account`,
      resetHeading: 'Reset your password',
      resetBody: (sentBy, hours) => `${sentBy ? `${sentBy} sent you a link to reset your ShiftBoard password.` : 'Someone asked to reset the password for your ShiftBoard account.'} This link works for ${hours === 1 ? '1 hour' : `${hours} hours`} and can be used once.`,
      resetButton: 'Choose a new password',
      resetFooter: "If you didn't ask for this, ignore this email. Your password stays the same.",
      resetSubject: (restaurant) => `Reset your ${restaurant} ShiftBoard password`,
      testHeading: 'Email is working',
      testBody: 'This is a test from ShiftBoard. Staff will now get emails for schedule updates, trades, time off and event changes, and new people get a link to set their password.',
      testFooter: 'Sent from the Settings page.',
      testSubject: 'ShiftBoard test email',
      // ----- sign-in link and security notices (always sent: they're about the account) -----
      linkSubject: (restaurant) => `Your ${restaurant} ShiftBoard sign-in link`,
      linkHeading: 'Your sign-in link',
      linkBody: 'You asked to sign in with an email link. It works once, for the next 15 minutes.',
      linkButton: 'Sign in to ShiftBoard',
      linkFooter: "If you didn't ask for this, someone has your authenticator code: change your password in My settings, or tell your manager.",
      securitySubject: (restaurant) => `Your ${restaurant} ShiftBoard two-step sign-in was reset`,
      securityHeading: 'Your two-step sign-in was reset',
      securityBody: (by) => `${by || 'A manager'} reset the second step of your ShiftBoard sign-in (authenticator app, passkeys and recovery codes). You were signed out everywhere. The next time you sign in with your password, you'll set up a new authenticator app or passkey.`,
      securityFooter: "If you didn't ask for this, tell your manager right away.",
    },
  },

  es: {
    // ----- horario -----
    newShift: (shift) => `Turno nuevo: ${shift}`,
    shiftChanged: (shift) => `Tu turno cambió: ${shift}`,
    addedTo: (shift) => `Te agregaron a este turno: ${shift}`,
    removedFrom: (shift) => `Te quitaron de este turno: ${shift}`,
    shiftRemoved: (shift) => `Se quitó un turno: ${shift}`,
    weekCleared: (date) => `Tus turnos de la semana del ${date} se quitaron del horario. Pronto saldrá un horario nuevo.`,
    schedulePosted: (from, to) => `Ya se publicó el horario del ${from} al ${to}. Revisa tus turnos.`,
    eventShiftsPosted: (event) => `Ya se publicaron los turnos del evento ${event}. Revisa tus turnos.`,
    openShiftsPosted: (n) => (n === 1 ? 'Hay 1 turno disponible para recoger.' : `Hay ${n} turnos disponibles para recoger.`),
    // ----- volver a borrador (core/unpublish.js) -----
    schedulePulledBack: (from, to, scope, note, by) => `El horario del ${from} al ${to}${scope ? ` (${scope})` : ''} volvió a borrador para hacer cambios. Te avisaremos cuando se publique de nuevo.${note ? ` Nota de ${by}: “${note}”` : ''}`,
    reasonPulledBack: 'el horario volvió a borrador para hacer cambios',
    republishedChanges: (from, to, changes) => `Se volvió a publicar el horario del ${from} al ${to}. Lo que cambió para ti: ${changes}`,
    republishedSame: (from, to) => `Se volvió a publicar el horario del ${from} al ${to}. Tus turnos no cambiaron.`,
    changeAdded: (shift) => `se agregó ${shift}`,
    changeRemoved: (shift) => `se quitó ${shift}`,
    changeMoved: (shift, to) => `se movió ${shift} → ${to}`,
    // ----- cambios -----
    requestCancelled: (reason) => `Se canceló la solicitud: ${reason}`,
    reasonChanged: 'un gerente cambió el turno',
    reasonRemoved: 'se quitó el turno',
    reasonEventRemoved: 'se quitó el evento',
    requestFilled: (shift) => `Se cerró tu solicitud para ${shift}: ya se cubrió.`,
    wantsPickup: (name, shift) => `${name} quiere recoger el turno ${shift}`,
    givingAway: (name, shift) => `${name} está cediendo el turno ${shift}. ¿Lo quieres recoger?`,
    wantsTrade: (name, mine, yours) => `${name} quiere intercambiar su turno ${mine} por tu turno ${yours}`,
    tookYourShift: (name, shift) => `${name} tomó tu turno ${shift}. Ya es oficial.`,
    acceptedTrade: (name) => `${name} aceptó tu intercambio. Falta que un gerente lo apruebe.`,
    acceptedShift: (name) => `${name} aceptó tu turno. Falta que un gerente lo apruebe.`,
    approvalNeeded: (type, shift, from, to) => `Falta aprobar: ${type === 'swap' ? 'intercambio' : 'cesión'} del turno ${shift} (${from} → ${to})`,
    declinedTrade: (name) => `${name} rechazó tu solicitud de intercambio.`,
    cancelledRequest: (name) => `${name} canceló la solicitud.`,
    approved: (type, shift) => `Aprobado: ${type === 'swap' ? 'el intercambio del' : type === 'pickup' ? 'que recojas el' : 'la cesión del'} turno ${shift}. Revisa tu horario actualizado.`,
    denied: (shift, note) => `Rechazada: la solicitud para ${shift}${note ? ` — ${note}` : ''}`,
    // ----- días libres -----
    requestedOff: (name, from, to) => (to ? `${name} pidió días libres del ${from} al ${to}` : `${name} pidió el día libre el ${from}`),
    timeOffDecided: (status, from, to) => `Se ${status === 'approved' ? 'aprobó' : 'rechazó'} tu solicitud de día libre: ${from}${to ? ` – ${to}` : ''}.`,
    // ----- eventos -----
    beoUpdated: (event, date) => `Se actualizó el BEO: ${event} (${date}). Revisa los detalles más recientes.`,
    newEvent: (event, date, guests) => `Evento nuevo: ${event} el ${date}, ${guests} invitados`,
    eventCancelled: 'Se canceló un evento en el que tenías turno.',
    eventComment: (name, event, text) => `${name} en ${event}: “${text}”`,
    // ----- eventos de Tripleseat (core/tripleseat.js) -----
    tsBeoChanged: (event, date, what) => `Se actualizó el BEO desde Tripleseat: ${event} (${date}). ${what}. Revisa los detalles más recientes.`,
    tsWhatDate: (date) => `Nueva fecha: ${date}`,
    tsWhatTime: (time) => `Nuevo horario: ${time}`,
    tsWhatGuests: (n) => `${n} invitado${s(n, '', 's')}`,
    tsWhatRoom: (room) => `Salón: ${room}`,
    tsCancelledStaffed: (event, date, n) => `${event} (${date}) se canceló o se quitó en Tripleseat, pero ${s(n, 'todavía hay 1 persona programada', `todavía hay ${n} personas programadas`)}. Revisa el evento.`,
    tsMovedStaffed: (event, date, n) => `${event} ahora es el ${date} en Tripleseat. ${s(n, 'El turno de 1 persona sigue', `Los turnos de ${n} personas siguen`)} en el día anterior. Revisa el evento.`,
    // ----- personas -----
    roleNow: (role) => `Ahora tu rol es ${role}.`,
    deletionRequested: (name) => `${name} pidió borrar su cuenta de ShiftBoard. Quita su acceso y sus datos personales en Equipo.`,
    // ----- propinas -----
    tipsFinal: (period, amount) => `Tus propinas de ${period} ya son definitivas: ${amount}. Toca para ver cómo se calcularon.`,
    tipsReopened: (period) => `Se reabrieron tus propinas de ${period} y pueden cambiar. Te avisaremos cuando sean definitivas.`,
    // ----- turnos -----
    openShift: 'Turno disponible',
    shift: 'Turno',
    untilClose: 'cierre',
    forecastNote: (daypart, covers) => `Pronóstico: ${daypart} (${covers} cubiertos)`,
    // ----- conflictos -----
    conflict: {
      unknown: 'Empleado desconocido',
      inactive: (name) => `${name} ya no está activo en ShiftBoard`,
      untrained: (name, job) => `${name} no tiene el puesto de ${job}`,
      overlap: (shift) => `Se cruza con ${shift}`,
      timeOffApproved: 'Día libre aprobado',
      timeOffPending: 'Solicitud de día libre pendiente',
      unavailable: 'Marcó que no está disponible este día',
      availableFrom: (time) => `Disponible desde las ${time}`,
      availableUntil: (time) => `Disponible hasta las ${time}`,
      overtime: (hrs) => `Horas extra: ${hrs} h esta semana`,
    },
    // ----- notificaciones al teléfono y mensajes de texto -----
    more: (n) => ` (+${n} más)`,
    pushTest: 'Prueba: las notificaciones del teléfono funcionan.',
    // STOP and HELP stay in English: carriers only act on those keywords.
    smsTest: (restaurant) => `${restaurant}: Mensaje de prueba de ShiftBoard. Los mensajes de texto funcionan. Responde STOP para dejar de recibir mensajes.`,
    // El mensaje de bienvenida está en core/consent.js (WELCOME_TEXT).
    // ----- correos -----
    email: {
      hi: (first) => `Hola, ${first}:`,
      there: '',
      open: 'Abrir ShiftBoard',
      notificationFooter: 'Recibes estos correos por las novedades en ShiftBoard. Para dejar de recibirlos, abre Mis turnos y apaga las notificaciones por correo.',
      inviteHeading: (restaurant) => `Ya estás en el horario de ${restaurant}`,
      inviteBody: (restaurant, invitedBy) => `${invitedBy ? `${invitedBy} te agregó` : 'Te agregaron'} a ShiftBoard, donde ${restaurant} publica el horario, los cambios de turno, los días libres y los detalles de los eventos.`,
      inviteSetPassword: 'Configura tu cuenta: elige una contraseña, protege tu inicio de sesión y agrega tu foto. Este enlace sirve por 7 días y se puede usar una sola vez.',
      inviteButton: 'Configurar mi cuenta',
      inviteFooter: (email) => `Tu correo para iniciar sesión es ${email}. Si no esperabas este correo, puedes ignorarlo.`,
      inviteSubject: (restaurant) => `Crea tu cuenta para el horario de ${restaurant}`,
      resetHeading: 'Restablece tu contraseña',
      resetBody: (sentBy, hours) => `${sentBy ? `${sentBy} te mandó un enlace para restablecer tu contraseña de ShiftBoard.` : 'Alguien pidió restablecer la contraseña de tu cuenta de ShiftBoard.'} Este enlace sirve por ${hours === 1 ? '1 hora' : `${hours} horas`} y se puede usar una sola vez.`,
      resetButton: 'Elegir una contraseña nueva',
      resetFooter: 'Si no lo pediste, ignora este correo. Tu contraseña sigue igual.',
      resetSubject: (restaurant) => `Restablece tu contraseña de ShiftBoard en ${restaurant}`,
      testHeading: 'El correo funciona',
      testBody: 'Esta es una prueba de ShiftBoard. Ahora el personal recibirá correos con los cambios del horario, los cambios de turno, los días libres y los eventos, y las personas nuevas recibirán un enlace para elegir su contraseña.',
      testFooter: 'Enviado desde la página de Configuración.',
      testSubject: 'Correo de prueba de ShiftBoard',
      linkSubject: (restaurant) => `Tu enlace para iniciar sesión en ShiftBoard de ${restaurant}`,
      linkHeading: 'Tu enlace para iniciar sesión',
      linkBody: 'Pediste iniciar sesión con un enlace por correo. Sirve una sola vez, durante los próximos 15 minutos.',
      linkButton: 'Iniciar sesión en ShiftBoard',
      linkFooter: 'Si no lo pediste, alguien tiene tu código de autenticación: cambia tu contraseña en Mi configuración o avísale a tu gerente.',
      securitySubject: (restaurant) => `Se restableció tu verificación en dos pasos de ShiftBoard en ${restaurant}`,
      securityHeading: 'Se restableció tu verificación en dos pasos',
      securityBody: (by) => `${by || 'Un gerente'} restableció el segundo paso de tu inicio de sesión en ShiftBoard (app de autenticación, llaves de acceso y códigos de recuperación). Se cerró tu sesión en todos lados. La próxima vez que inicies sesión con tu contraseña, vas a configurar una app de autenticación o una llave de acceso nueva.`,
      securityFooter: 'Si no lo pediste, avísale a tu gerente de inmediato.',
    },
  },
};

/** The catalog for a language (English for anything unknown). */
export const msg = (lang) => MSG[lang] || MSG.en;
