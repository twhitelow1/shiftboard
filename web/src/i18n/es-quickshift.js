// Modo rápido del diálogo de turno (una celda persona × día del horario): copiar una hora, mover un turno, día de descanso.
// Mismas claves que en-quickshift.js.
export default {
  quickShift: {
    fixedHelp: 'De la fila en la que hiciste clic. Aquí solo cambian la hora, la etiqueta y las notas.',
    copyTime: 'Copiar una hora',
    theirWeek: 'Sus otros días de esta semana',
    commonFor: 'Comunes para {position} esta semana',
    noTimesYet: 'Todavía no hay otras horas esta semana.',
    keyHint: 'Presiona 1–9 para elegir',
    timesCount: '×{count}',
    timeIn: 'Hora de entrada',
    timeOut: 'Hora de salida',
    moveShift: 'Mover este turno',
    moveHelp: 'Cambia la fecha, la persona o el puesto. Esto mueve el turno (el mismo turno); no agrega otro.',
    changeAll: 'Cambiar fecha, persona o puesto',
    moving: 'Al guardar se mueve este turno: es el mismo turno, no una copia.',
    saveMove: 'Mover turno',
    moved: 'Turno movido',
    dayOff: 'Día de descanso',
    dayOffConfirm: { one: 'Toca otra vez: quitar {count} turno y marcar descanso', other: 'Toca otra vez: quitar {count} turnos y marcar descanso' },
    dayOffDone: '{name} descansa el {date}',
    isDayOff: '{name} tiene este día marcado de descanso. Puedes agregar un turno igual; mostrará un aviso.',
    undoDayOff: 'Deshacer descanso',
    dayOffCleared: 'Día de descanso quitado',
    cell: 'DESCANSO',
    cellTitle: 'Marcado de descanso a propósito por un gerente',
    plusShift: '+ Turno',
    addShift: 'Agregar turno',
    undo: 'Deshacer',
  },
};
export const scheduleLog = { g_dayOff: 'Días de descanso' };
