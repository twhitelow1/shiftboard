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
| room (a banner on the schedule: Restaurant, Moon Rabbit…) | salón | room names stay as entered; same word as the venue's rooms |
| Rooms & positions (Settings) | Salones y puestos | |
| hidden (position) / hide / show | oculto / ocultar / mostrar | "Ocultar en el horario" |
| name on the sheet (a section's label) | nombre en el horario | |
| hidden or unlisted section | sección oculta o fuera del horario | the schedule's notice for managers |
| show everyone (shift editor) | mostrar a todos | |
| main position | puesto principal | Team |
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
| unpublish (a posted week back to draft) / pulled back for changes | volver a borrador · regresar … a borrador / volvió a borrador para hacer cambios | button "Volver a borrador…", confirmation "¿Regresar la semana del … a borrador?"; not "despublicar" (reads like jargon) |
| notify staff (checkbox on a schedule change) | avisar al personal | "no recibirá aviso" when it's off |
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
| From Tripleseat: edit it there | De Tripleseat: cámbialo allá | Tripleseat status names (Definite, Tentative, Prospect, Closed, Lost) stay in English, with the Spanish in parentheses in Settings |
| sales manager | gerente de ventas | the event's owner in Tripleseat |
| integrations / connection / not set up | integraciones / conexión / sin configurar | Settings → Integrations |
| webhook / signing key | webhook / clave de firma | |

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

## 86 List

| English | Español | Notes |
|---|---|---|
| 86 / 86 List | 86 / Lista 86 | "86" stays "86" |
| 86'd (out) | agotado · se acabó | pill reads "86"; button "Se acabó (86)"; notification "Bar: no hay Mezcal (…)" (works for plurals: "no hay servilletas") |
| running low | queda poco | button and status; counts in banners read "2 por acabarse" |
| 3 left | quedan 3 · queda 1 | |
| back in stock | ya hay | button; "Ya hay Mezcal" after tapping it |
| report (something 86'd) | reportar | |
| undo | deshacer | |
| list (Bar, Kitchen) | lista (Bar, Cocina) | the default Kitchen list is "Cocina"; admins can give any list a Spanish name |
| Kitchen & floor | Cocina y salón | the column next to the bar's lists |
| clear the list each night at… | vaciar la lista cada noche a las… | the nightly reset |
| history / log | historial / registro | |
| most 86'd | lo que más se acabó | |
| photo / photos (optional) | foto / fotos (opcional) | |
| take photo / choose photo | tomar foto / elegir foto | phone app buttons |
| remove photo | quitar foto | |
| ingredients and supplies (what the 86 List is for) | ingredientes y suministros | "No platillos del menú" (not menu items) |
| stock / order (supplies) | tener en existencia / pedir | "lo que tenemos en existencia o pedimos" |
| out of limes (notification) | no hay limones | "Bar: no hay limones (…)"; English "Bar: out of limes" |
| running low on CO2 (notification) | queda poco de CO2 | "Bar: queda poco de CO2 (queda 1)" |
| all stocked | todo surtido | empty list |
| reported here before | reportado aquí antes | the report form's suggestions |
| category (of an item) | categoría | optional; "Sin categoría" for none |
| Produce · Dairy · Proteins · Dry goods | Frutas y verduras · Lácteos · Proteínas · Abarrotes | default categories; "Abarrotes" *review* (or "Productos secos") |
| Liquor, beer & wine · Paper & disposables | Licores, cerveza y vino · Papel y desechables | default categories |
| Glassware & smallwares · Cleaning & chemicals · Other | Cristalería y utensilios · Limpieza y químicos · Otros | default categories; "utensilios" *review* |
| rocks glasses | vasos bajos | examples in help text |
| Also suggest menu items | Sugerir también platillos del menú | Settings → 86 List, off by default |

## Reports (managers)

| English | Español | Notes |
|---|---|---|
| Reports / report | Informes / informe | not "reportes": "reportar" is for the 86 List; *review* |
| 86 List report | informe de la Lista 86 | |
| Missing now / History / Trends | Lo que falta / Historial / Tendencias | the report's tabs |
| shopping list | lista de compras | "Lista de compras: lo que necesitamos" |
| OUT: … · LOW: … (shopping list) | AGOTADO: … · QUEDA POCO: … | |
| hidden from staff (a list) | el personal no la ve | |
| season (Winter 2025–26, Summer 2026) | temporada (Invierno 2025–26, Verano 2026) | names come from core/seasons.js |
| this season / last year / same number of days in | esta temporada / el año pasado / con los mismos días transcurridos | Trends |
| times out / times low | veces agotado / veces que quedó poco | |
| repeat offenders | lo que se acaba seguido | "se acabó 6 veces esta temporada" |
| who reports most | quién reporta más | |
| average time out | tiempo agotado en promedio | |

## App words

| English | Español | Notes |
|---|---|---|
| sign in / sign out | iniciar sesión / cerrar sesión | |
| two-step sign-in | verificación en dos pasos | |
| authenticator app / 6-digit code | app de autenticación / código de 6 dígitos | |
| recovery code | código de recuperación | "Cada uno sirve una vez" |
| setup key | clave de configuración | |
| passkey | llave de acceso (passkey) | web-only for now |
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

## Training (website and phone app)

| English | Español | Notes |
|---|---|---|
| Training (tab) | Capacitación | the phone's tab label is a point smaller in Spanish so five tabs fit |
| menu study guide / menu item | guía del menú / platillo | "3 platillos" |
| flashcards | tarjetas de estudio · tarjetas | button "Tarjetas" |
| quiz / quizzes | cuestionario / cuestionarios | |
| hand it in / see my score | entregar / ver mi puntaje | |
| passed / not passed | aprobado / no aprobado | |
| leaderboard | clasificación | |
| items mastered | platillos dominados | |
| employee manual / handbook | manual del empleado | tab: "Manual" |
| I've read this / read again | ya lo leí / volver a leer | |
| manager on duty | gerente en turno | |
| call / text (buttons) | llamar / mensaje | "Mandar un mensaje a Kelly" for screen readers |
| call-out line | línea para avisos | |
| Can't make it? Call out | ¿No puedes ir? Avisa | the panel on your own upcoming shift |
| allergens / what's in it / how to sell it | alérgenos / qué lleva / cómo venderlo | |
| recipe / prep notes / makes | receta / notas de preparación / rinde | |

## Phone app, version 2

| English | Español | Notes |
|---|---|---|
| Day / Week (schedule) | Día / Semana | |
| projected covers | cubiertos proyectados | "~157" under each day |
| your section / your tables | tu sección / tus mesas | "Tus mesas: T1, T4 · 12 lugares" |
| My tables / Whole room | Mis mesas / Todo el salón | floor plan switch |
| my tips / your share / how it was worked out | mis propinas / tu parte / cómo se calculó | |
| estimate / final (tips) | estimado / definitivo | |
| Today on the floor | Hoy en el salón | shift leads' and managers' screen |
| working now / coming in later today | trabajando ahora / entran más tarde hoy | |
| publish the week of … | publicar la semana del … | confirmation before publishing |
| restaurants (on this phone) / add another restaurant | restaurantes / agregar otro restaurante | |
| switch to … / open now | cambiar a … / abierto | |
| no connection, showing what you last saw | sin conexión, mostrando lo último que viste | offline note |
| any time / some hours / unavailable | todo el día / por horas / no disponible | availability |
| opening / close (availability with no time) | la apertura / el cierre | |
| waiting on coworkers / recently decided | esperando a los compañeros / decididos hace poco | approvers in Trades |

## Reports and announcements

| English | Español | Notes |
|---|---|---|
| Trades & pickups (report) | Cambios y turnos recogidos | phone title: Conteo de cambios |
| put up (shifts offered: give-aways + trades offered) | ofrecidos | column; "ofreciste 3" |
| picked up | recogidos | |
| not taken / taken / waiting | sin tomar / tomados / en espera | *review* |
| net hours / hours given / hours taken | horas netas / horas cedidas / horas tomadas | |
| season / Winter / Summer / Spring / Fall | temporada / Invierno / Verano / Primavera / Otoño | "Invierno 2025–26" |
| compare seasons / a year ago / season before | comparar temporadas / hace un año / temporada anterior | |
| announcement / announcements | aviso / avisos | not "anuncio" (sounds like an ad) |
| audience ("who gets it") | quién lo recibe | |
| quiet hours | horario de silencio | *review* |
| urgent | urgente | |
| read receipts / read by 12 | lo leyeron 12 | |
| Reply STOP to opt out | Responde STOP para cancelar | STOP stays in English (carriers) |

## Notifications, emails and errors

- Notifications start with what happened, then the shift: "Turno nuevo: Server (Restaurant) mar, 6 de oct · 4 pm–cierre", "Ana quiere intercambiar su turno … por tu turno …".
- Emails open with "Hola, Ana:" and use the same words as the app ("Abrir ShiftBoard", "Configurar mi cuenta").
- The welcome text (first opt-in only; exact words in core/consent.js): "ShiftBoard de DubLow Digital: Te suscribiste a las alertas de tu horario de turnos. La frecuencia de los mensajes varía. Pueden aplicar tarifas de mensajes y datos. Responde HELP para ayuda, STOP para cancelar." *review*
- Error messages say what to do: "Elige una semana", "Falta la fecha", "Solo para gerentes", "No encontramos ese turno".

## Sign-in, two-step and consent

| English | Español | Notes |
|---|---|---|
| sign in / sign-in link | iniciar sesión / enlace para iniciar sesión | |
| two-step sign-in | verificación en dos pasos | "Dos pasos activado" on badges |
| second step | segundo paso | |
| authenticator app | app de autenticación | Google Authenticator, etc. stay as named |
| 6-digit code | código de 6 dígitos | |
| passkey | llave de acceso | Apple's and Google's Spanish word |
| recovery codes | códigos de recuperación | |
| secure your account | protege tu cuenta | |
| My settings | Mi configuración | the page; "Inicio de sesión y seguridad" is its section |
| invitation / invite | invitación / invitar | "Reenviar invitación" |
| Joined (status) | Ya entró | *review* |
| consent | consentimiento | |
| I agree to… | Acepto… | checkbox sentences: exact words in core/consent.js, *review* |
| required / optional | obligatorio / opcional | |
| Privacy Policy / Terms | Política de privacidad / Términos | |
| texts on / off / stopped | mensajes activados / desactivados / detenidos | STOP and HELP stay in English |
