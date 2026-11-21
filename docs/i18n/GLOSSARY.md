# English → Spanish glossary

The words ShiftBoard uses in Spanish, so the phone app, the website and emails say the same thing.

- **Spanish:** neutral Latin American (es-419), for US restaurant teams. Informal **tú** ("Pide tu día libre", "Cambia tu turno"). Short and plain.
- **Always** correct accents and opening marks: ¿…? ¡…!
- **Not translated:** restaurant data (people's names, positions/job codes, areas, sections, notes managers type). Position names below are for anything ShiftBoard itself writes (help text, defaults, emails).
- **Review:** a native speaker on staff, please check this list and the apps. Mark changes here first, then in the catalogs.
- **Where the words live:** the phone app `mobile/src/i18n/es.ts`; the website `web/src/i18n/es.js` (and Training's `web/src/training-strings.js`); what the server writes (notifications, emails, texts, conflict warnings) `core/messages.js`; error messages `core/errors.js`; role names `core/roles.js`; tip pool wording `core/tips.js`.
- **Dates and times:** dates come from the phone's or browser's Spanish (US) format: "jue, 24 de dic", "24 dic", "diciembre de 2026". Times read "4 pm", "4:30 pm"; until close reads "4 pm–cierre". The printed Sheet view keeps the house sheet's own times ("4PM", "1-9PM").
- **Words to check first:** the ones marked *review* in the Notes column are choices a native speaker should confirm.

## Schedule and shifts

| English | Español | Notes |
|---|---|---|
| shift | turno | |
| my shifts | mis turnos | tab name |
| schedule | horario | tab name; "el horario de la semana" |
| next shift | tu próximo turno | |
| open shift (nobody assigned) | turno disponible | not "turno libre" (sounds like a day off) |
| until close / CL | hasta el cierre · cierre | times read "4 pm–cierre" |
| draft (not posted) | borrador | |
| post / publish the schedule | publicar el horario | |
| week of Dec 21 | semana del 21 de dic | |
| this week / next week | esta semana / la próxima semana | |
| area (Restaurant, Rabbit Hole…) | área | names stay as entered |
| position / job code | puesto | |
| section / tag (LIB, BC…) | sección | tags stay as entered |
| event (BEO) | evento | BEO stays "BEO" |
| covers | cubiertos | |
| closed | cerrado | |
| you're off | tienes el día libre | |
| hours (32.5 hrs) | horas (32.5 h) | |
| week view: Sheet / Grid / By employee / Day | Hoja / Cuadrícula / Por empleado / Día | schedule views |
| OFF (sheet cell) | LIBRE | printed in capitals like the house sheet |
| REQUEST OFF / REQ PENDING (sheet cell) | PIDIÓ LIBRE / SOLICITUD PENDIENTE | *review* |
| Projected Covers (sheet row) | Cubiertos proyectados | |
| day note / Notes line | nota del día / línea de Notas | |
| publish / published | publicar / publicado | "Publicar (3)" |
| copy week / clear week / import | copiar semana / vaciar semana / importar | |
| open shift (sheet) | DISPONIBLE | |
| shift start / end | entrada / salida | shift dialog |
| unpaid break | descanso sin pago | |
| tag (LIB, RH…) | etiqueta | tags stay as entered |
| conflict: overlaps … | se cruza con … | "Se cruza con Server (Restaurant) sáb, 3 de oct · 4 pm–cierre" |
| overtime | horas extra | "Horas extra: 41.5 h esta semana" |
| approved time off / time-off request pending | día libre aprobado / solicitud de día libre pendiente | conflict warnings |

## Trades

| English | Español | Notes |
|---|---|---|
| trade (a shift) | intercambio · intercambiar | "Intercambiar con un compañero" |
| trades (tab) | cambios | short tab name |
| give away (a shift) | ceder (un turno) | noun: cesión |
| pick up (a shift) | recoger (un turno) | "Recoger turno" |
| up for grabs | disponibles | tab: shifts offered to you + open shifts |
| request | solicitud | "Mis solicitudes" |
| accept / decline | aceptar / rechazar | |
| approve / deny | aprobar / rechazar | |
| pending | pendiente | |
| waiting on manager | esperando al gerente | |
| waiting on coworker | esperando a tu compañero | |
| coworker | compañero / compañera | |
| giveaway (noun) | cesión | badge on a request |
| open shift pickup | recoger turno disponible | badge on a request |
| auto-approved | aprobado automáticamente | |
| declined (by the coworker) | no aceptado | status; "rechazado" is a manager's deny |

## Time off

| English | Español | Notes |
|---|---|---|
| time off | días libres · tiempo libre | tab: "Días libres" |
| request time off | pedir día libre | button |
| day off | día libre | |
| availability | disponibilidad | |
| reason | motivo | |
| any time / some hours / unavailable | todo el día / por horas / no disponible | availability, per weekday |
| time off recorded | día libre registrado | entered by a manager for someone |

## People and roles

| English | Español | Notes |
|---|---|---|
| manager | gerente | |
| manager on duty | gerente en turno | Training portal (later) |
| shift lead / supervisor | supervisor / supervisora | role name |
| employee | empleado / empleada | role name in More shows "Empleado" |
| admin / super admin | administrador / superadministrador | |
| server | mesero / mesera | |
| busser | garrotero / garrotera | |
| bartender | cantinero / cantinera · bartender | both are common |
| host | anfitrión / anfitriona | |
| food runner | corredor / corredora | |
| barback | ayudante de barra | |
| banquet captain | capitán de banquetes | |
| cook / line cook | cocinero / cocinera · cocinero de línea | |
| dishwasher | lavaplatos | |
| role | rol | Super Admin, Admin, Manager, Supervisor, Employee → Superadministrador, Administrador, Gerente, Supervisor, Empleado (plural: …es, Gerentes, Supervisores, Empleados) |
| job code / position | puesto | job code names stay as entered |
| pay rate | tarifa de pago | "$18/h" |
| team / people | equipo / personas | "Equipo y puestos" (Team & Job Codes) |
| invite / sign-in link | invitar / enlace para entrar | |
| temporary password | contraseña temporal | |
| merge (two people or job codes) | unir | "Unir con otro puesto" |
| archive / restore | archivar / restaurar | |
| events coordinator | quien coordina los eventos | |

## Events (BEO)

| English | Español | Notes |
|---|---|---|
| Events & BEOs | Eventos y BEO | BEO stays "BEO" (no plural s) |
| banquet event order | orden de evento (BEO) | print heading |
| guests / guaranteed | invitados / garantizados | |
| guest arrival | llegada de invitados | |
| call time | hora de llegada | for staff |
| staffing / staffing needed | personal / personal necesario | |
| service style | tipo de servicio | |
| plated dinner / family style / buffet / stations | cena servida a la mesa / estilo familiar / bufé / estaciones | *review* |
| reception / passed apps | recepción / bocadillos pasados | *review* |
| bar / cocktail only | solo barra / cóctel | |
| setup / A/V / timeline | montaje / audio y video / programa | |
| tentative / confirmed / completed | tentativo / confirmado / terminado | |
| attire / all black | vestimenta / todo negro | |
| team thread | conversación del equipo | |
| course (menu) | tiempo | "Plato fuerte" for entrée |

## Forecast and labor

| English | Español | Notes |
|---|---|---|
| Forecast & Labor | Pronóstico y mano de obra | phone title: Pronóstico |
| labor / labor % / labor cost | mano de obra / % de mano de obra / costo de mano de obra | *review* |
| labor rules | reglas de personal | |
| daypart (Lunch, Dinner) | horario del día | daypart names stay as entered |
| peak | pico | "hora pico" |
| target | meta | "meta 28%" |
| under-staffed / on target / over by 2+ | falta personal / en la meta / sobran 2 o más | |
| manager override | lo cambió un gerente | forecast basis |
| weighted average | promedio ponderado | |
| Labor review | Revisión de mano de obra | |
| clock-in / clock-out | checada (de entrada / de salida) | *review*: "checar" is common in Mexico; "marcar" elsewhere |
| scheduled → worked | en el horario → trabajado | |
| sync / match (Toast) | sincronizar / vincular | |

## Tips

| English | Español | Notes |
|---|---|---|
| tip pool | fondo común de propinas · fondo de propinas | |
| tips (page) | propinas | |
| tip-out | aporte | "Server aporta 3 % de sus ventas" *review* |
| card tips / cash tips | propinas con tarjeta / propinas en efectivo | |
| points | puntos | |
| split (hours × points, points per shift, equal) | repartir (horas × puntos, puntos por turno, partes iguales) | |
| adjustment | ajuste | |
| finalize the week / final | cerrar la semana / definitivo | |
| unlock | desbloquear | |
| estimate | estimado | |

## Venue and floor plans

| English | Español | Notes |
|---|---|---|
| Venue & Floor Plans | Local y planos | |
| venue / location | local / sucursal | |
| level (Main floor, Upstairs…) | piso (Planta baja, Planta alta…) | level names stay as entered |
| room | salón | room names stay as entered |
| floor plan | plano | |
| table / seats | mesa / lugares | "6 mesas · 20 lugares (8 en la barra)" |
| round / square / long table | mesa redonda / cuadrada / larga | |
| booth | gabinete | *review* (also "booth" or "reservado") |
| bar / bar stools | barra / bancos de barra | |
| stage / dance floor / DJ booth / host stand | escenario / pista de baile / cabina del DJ / puesto del anfitrión | |
| sections (server sections) | secciones | |

## App words

| English | Español | Notes |
|---|---|---|
| sign in / sign out | iniciar sesión / cerrar sesión | |
| forgot your password? | ¿olvidaste tu contraseña? | |
| reset your password | restablece tu contraseña | |
| restaurant address | dirección del restaurante | "dirección de ShiftBoard de tu restaurante" |
| invite link / QR code | enlace de invitación / código QR | |
| notifications | notificaciones | |
| more | más | tab name |
| language | idioma | button label "Cambiar idioma"; menu shows English / Español |
| restaurant default | del restaurante | "Del restaurante (Automático)" |
| auto / light / dark | automático / claro / oscuro | appearance |
| settings | configuración | page name |
| branding & theme | marca y tema | |
| phone notifications | notificaciones del teléfono | |
| text messages / texts | mensajes de texto | STOP and HELP stay in English (carriers) |
| email notifications | notificaciones por correo | |
| draft (badge) | borrador | |
| saved | guardado | toasts |
| training | capacitación | "Muy pronto" = coming soon |
| delete my account | borrar mi cuenta | |
| privacy policy | política de privacidad | |
| help & support | ayuda y soporte | |
| try again | reintentar | |
| continue / cancel / save / send | continuar / cancelar / guardar / enviar | |

## Notifications, emails and errors

- Notifications start with what happened, then the shift: "Turno nuevo: Server (Restaurant) mar, 6 de oct · 4 pm–cierre", "Ana quiere intercambiar su turno … por tu turno …".
- Emails open with "Hola, Ana:" and use the same words as the app ("Abrir ShiftBoard", "Elegir mi contraseña").
- The welcome text: "Recibirás mensajes sobre tu horario, cambios de turno y días libres. Pueden aplicar tarifas de mensajes y datos. Responde STOP para dejar de recibir mensajes, HELP para ayuda."
- Error messages say what to do: "Elige una semana", "Falta la fecha", "Solo para gerentes", "No encontramos ese turno".
