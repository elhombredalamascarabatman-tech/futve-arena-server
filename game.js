// ============================================================
// FUTVE ARENA — gestor de salas/partidas del servidor autoritativo.
// Cada MatchRoom controla un partido servidor-autoritativo entre 2
// (1v1), 8 (4v4) o 14 (7v7) slots humanos posibles, repartidos en dos
// equipos (home/away). El servidor NUNCA acepta posiciones del
// cliente: solo botones de dirección (arriba/abajo/izquierda/derecha)
// y si mantiene pulsado el disparo, por cada slot humano. Todo lo demás
// (posición, física, goles, marcador, tiempo, resultado) lo calcula y
// decide este módulo (vía MatchSim, ver physics.js).
//
// POLÍTICA DE ASIGNACIÓN DE EQUIPO/SLOT AL UNIRSE (orden de llegada):
// el anfitrión SIEMPRE es home #0. Cada joinRoom() posterior alterna
// de equipo empezando por 'away' (away#0, home#1, away#1, home#2, ...),
// ocupando siempre el slot vacío de menor índice de ese equipo; si ese
// equipo ya está completo, cae en el otro equipo (y viceversa). Así los
// dos equipos se llenan de forma pareja a medida que la gente se une,
// sin necesidad de que nadie elija equipo a mano (fuera de alcance de
// este slice — ver "team-switching" en la instrucción maestra).
// ============================================================

const { MatchSim, ARENA_FORMATIONS } = require('./physics.js');

const TICK_HZ = 30; // pasos de física por segundo (servidor)
const TICK_DT = 1 / TICK_HZ;
const BROADCAST_EVERY_N_TICKS = 1; // 30Hz de estado hacia los clientes

const SLOTS_PER_SIDE = { '1v1': 1, '4v4': 4, '7v7': 7 };

// Regla 71 pide "un límite configurable" para cuándo una desconexión se
// considera abandono y pasa a manos de la IA. Se deja aquí como constante
// nombrada y fácil de ajustar, aunque en esta pasada se usa en 0 (toma de
// control INMEDIATA en el evento 'close'):
//   - "reconectar" está explícitamente fuera de alcance de este slice (ver
//     handleDisconnect() más abajo) — no existe ningún camino por el que una
//     conexión "vuelva" dentro de una ventana de gracia y recupere su slot,
//     así que una ventana de espera no protegería nada real: solo dejaría
//     ese jugador plantado sin moverse unos segundos de más antes de que
//     el bot lo releve, sin ganar ninguna funcionalidad a cambio.
//   - el caso que SÍ le preocupa a la regla 71 (un parpadeo de red de 1-2s
//     que no debería "gastar" al jugador) ya está cubierto en la capa de
//     transporte: mientras el objeto WebSocket siga vivo (el navegador
//     reintenta framing/reconexión TCP por debajo sin disparar 'close'),
//     esto ni se entera. Un 'close' real de la librería `ws` significa que
//     esa conexión concreta ya terminó de verdad — no es un blip.
// Si en una pasada futura se agrega reconexión-al-mismo-slot, este valor es
// el lugar natural para introducir una espera real antes de convertir a bot.
const DISCONNECT_GRACE_MS = 0;

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos (O/0, I/1)
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Convierte botones (up/down/left/right booleanos) a un vector de dirección
// normalizado -1..1, exactamente como ArenaInput.getMoveVector() en el cliente.
function inputToVector(buttons) {
  if (!buttons || typeof buttons !== 'object') return { x: 0, y: 0, shootPressed: false };
  let x = 0, y = 0;
  if (buttons.left) x -= 1;
  if (buttons.right) x += 1;
  if (buttons.up) y -= 1;
  if (buttons.down) y += 1;
  return { x, y, shootPressed: !!buttons.shootPressed };
}

function normalizeFormat(format) {
  return (format === '4v4' || format === '7v7') ? format : '1v1';
}

class MatchRoom {
  constructor(code, hostConn, format, formationKey) {
    this.code = code;
    this.format = normalizeFormat(format);
    this.slotsPerSide = SLOTS_PER_SIDE[this.format];
    this.sim = new MatchSim(this.format, formationKey);
    this.formationKey = this.sim.formationKey; // formato '1v1' -> null; si no, la formación realmente usada

    this.hostConn = hostConn;
    this.homeConns = new Array(this.slotsPerSide).fill(null);
    this.awayConns = new Array(this.slotsPerSide).fill(null);
    this.homeConns[0] = hostConn;
    hostConn.team = 'home';
    hostConn.slot = 0;

    this._nextJoinTeam = 'away'; // política de alternancia, ver cabecera del archivo

    this._interval = null;
    this._tickCount = 0;
    this.status = 'waiting'; // waiting -> playing -> ended
    this.createdAt = Date.now();
  }

  humanCount() {
    return this.homeConns.filter(Boolean).length + this.awayConns.filter(Boolean).length;
  }
  totalSlots() { return this.slotsPerSide * 2; }
  isFull() { return this.humanCount() >= this.totalSlots(); }

  // Asigna al próximo humano que se une a un (team, slot) libre, según la
  // política de alternancia documentada arriba. Devuelve {team, slot} o
  // {error:'room_full'}.
  addGuest(guestConn) {
    if (this.status !== 'waiting' || this.isFull()) return { error: 'room_full' };

    const tryTeam = (team) => {
      const conns = team === 'home' ? this.homeConns : this.awayConns;
      const slot = conns.findIndex(c => c === null);
      if (slot === -1) return null;
      conns[slot] = guestConn;
      guestConn.team = team;
      guestConn.slot = slot;
      return { team, slot };
    };

    let result = tryTeam(this._nextJoinTeam);
    if (!result) result = tryTeam(this._nextJoinTeam === 'home' ? 'away' : 'home');
    if (!result) return { error: 'room_full' };

    this._nextJoinTeam = this._nextJoinTeam === 'home' ? 'away' : 'home';
    return result;
  }

  allConns() {
    return this.homeConns.concat(this.awayConns).filter(Boolean);
  }

  // Regla 66 (CAMBIO DE EQUIPO): antes de arrancar, cualquier humano ya
  // unido puede pasarse al otro equipo si hay hueco allí. Solo mueve a ESA
  // conexión (nunca intercambia dos jugadores entre sí — no hace falta para
  // este slice, ver instrucción maestra). Devuelve {team, slot} con la
  // nueva asignación, o {error:'already_started'|'team_full'|'not_in_room'}.
  //
  // Nota de corrección de enrutado de input: esto muta conn.team/conn.slot
  // EN EL MISMO objeto de conexión (el mismo `ws` que index.js usa para
  // cada mensaje 'input' posterior) — no existe ninguna tabla aparte que
  // mapee slots antiguos a conexiones. setInput()/sim.setInput() siempre
  // leen conn.team/conn.slot en el momento de cada 'input' entrante, así
  // que en cuanto se actualizan aquí, el siguiente 'input' de esa conexión
  // ya se enruta solo al slot nuevo — no puede quedar una referencia stale.
  switchTeam(conn) {
    if (this.status !== 'waiting') return { error: 'already_started' };
    if (!conn.team || conn.slot == null) return { error: 'not_in_room' };

    const fromTeam = conn.team;
    const toTeam = fromTeam === 'home' ? 'away' : 'home';
    const fromConns = fromTeam === 'home' ? this.homeConns : this.awayConns;
    const toConns = toTeam === 'home' ? this.homeConns : this.awayConns;

    const targetSlot = toConns.findIndex((c) => c === null);
    if (targetSlot === -1) return { error: 'team_full' };

    // Confirma que conn de verdad está donde dice estar antes de tocar nada
    // (defensivo — no debería poder desalinearse, pero evita corromper el
    // array si alguna llamada futura pasa una conn ya obsoleta).
    if (fromConns[conn.slot] !== conn) return { error: 'not_in_room' };

    fromConns[conn.slot] = null;
    toConns[targetSlot] = conn;
    conn.team = toTeam;
    conn.slot = targetSlot;
    return { team: toTeam, slot: targetSlot };
  }

  // Lista de {team, slot, username} de todos los humanos ya unidos — para
  // que el cliente pueda mostrar el roster de la sala de espera.
  participants() {
    const out = [];
    this.homeConns.forEach((c, i) => { if (c) out.push({ team: 'home', slot: i, username: c.username || 'Jugador' }); });
    this.awayConns.forEach((c, i) => { if (c) out.push({ team: 'away', slot: i, username: c.username || 'Jugador' }); });
    return out;
  }

  setInput(conn, buttons) {
    if (!conn.team || conn.slot == null) return;
    const v = inputToVector(buttons);
    this.sim.setInput(conn.team, conn.slot, v);
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    this.allConns().forEach((c) => {
      try { if (c.readyState === 1) c.send(msg); } catch (e) {}
    });
  }

  // Host-only, puede llamarse en cuanto la sala existe (el anfitrión
  // siempre está presente en home#0) — cualquier slot sin humano al
  // momento de arrancar queda controlado por un bot de zona (ver
  // ZoneAIController en physics.js), nunca "sin jugador".
  start() {
    if (this.status !== 'waiting') return false;
    this.status = 'playing';

    const homeBotSlots = [];
    this.homeConns.forEach((c, i) => { if (!c) homeBotSlots.push(i); });
    const awayBotSlots = [];
    this.awayConns.forEach((c, i) => { if (!c) awayBotSlots.push(i); });
    this.sim.setBotSlots(homeBotSlots, awayBotSlots);

    this.sim.start();
    this.broadcast({
      type: 'matchStart',
      format: this.format,
      formationKey: this.formationKey,
      homeBotSlots, awayBotSlots,
    });
    this._interval = setInterval(() => this._tick(), TICK_DT * 1000);
    return true;
  }

  _tick() {
    if (this.status !== 'playing') return;
    const result = this.sim.tick(TICK_DT);
    this._tickCount++;

    if (result.goal) {
      this.broadcast({
        type: 'goal',
        scorer: result.goal,
        scoreHome: this.sim.scoreHome,
        scoreAway: this.sim.scoreAway,
      });
    }

    if (result.ended) {
      this.status = 'ended';
      this.broadcast({
        type: 'matchEnd',
        scoreHome: this.sim.scoreHome,
        scoreAway: this.sim.scoreAway,
      });
      this.stop();
      return;
    }

    if (this._tickCount % BROADCAST_EVERY_N_TICKS === 0) {
      this.broadcast({ type: 'state', state: this.sim.getSnapshot() });
    }
  }

  stop() {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }

  // Maneja la desconexión de UNA conexión. Devuelve {removeRoom: bool} para
  // que el llamador (index.js) sepa si debe borrar la sala del mapa.
  //  - Si la partida ya está en curso (status 'playing'): en vez de terminar
  //    la sala para todos como antes, el slot de esa conexión pasa a estar
  //    controlado por un ZoneAIController (bot) y LA PARTIDA SIGUE — regla
  //    71 ("su jugador puede ser controlado temporalmente por IA"). Esto
  //    aplica a CUALQUIER slot, incluido el anfitrión: la regla 72 (voto de
  //    nuevo capitán si se va específicamente el anfitrión) no se implementa
  //    aquí a propósito porque el sistema de votación de capitán todavía no
  //    existe en este proyecto (fuera de alcance, ver instrucción maestra);
  //    hasta que exista, el anfitrión que se desconecta a mitad de partido
  //    se trata exactamente igual que cualquier otro slot (se vuelve bot),
  //    en vez de tumbar la sala para el resto. Esto se aplica IGUAL en 1v1
  //    que en 4v4/7v7 (antes, en 1v1, el rival desconectado terminaba la
  //    partida al instante para el que quedaba — ver notas de diseño en la
  //    cabecera del archivo para la justificación de este cambio).
  //    Si con el tiempo TODOS los slots de ambos equipos terminan siendo
  //    bots (both humans left, algo improbable en 1v1 y posible pero raro
  //    en 4v4/7v7), no se hace nada especial: el partido bots-vs-bots sigue
  //    corriendo hasta terminar solo por tiempo, igual que cualquier otro.
  //    Reconectar al mismo slot (si esa persona vuelve a entrar) queda
  //    fuera de alcance de este slice — necesitaría emparejar identidad/
  //    sesión con el slot que dejó, una pieza más grande para otra pasada;
  //    quien se desconectó tendría que unirse a una sala nueva si quiere
  //    seguir jugando.
  //  - Si aún se está esperando (status 'waiting'): si se va el anfitrión,
  //    la sala deja de tener sentido (nadie más puede iniciarla) y se
  //    cierra para el resto; si se va cualquier otro humano, simplemente
  //    libera su slot y la sala sigue siendo unible por los demás.
  handleDisconnect(conn) {
    if (this.status === 'playing') {
      if (conn.team && conn.slot != null && !this.sim.isBotSlot(conn.team, conn.slot)) {
        this.sim.convertToBot(conn.team, conn.slot);
        if (conn.team === 'home') this.homeConns[conn.slot] = null;
        else if (conn.team === 'away') this.awayConns[conn.slot] = null;
        this._notifyOthers(conn, {
          type: 'slotBotTakeover',
          team: conn.team,
          slot: conn.slot,
          username: conn.username || 'Jugador',
        });
      }
      return { removeRoom: false };
    }

    if (conn === this.hostConn) {
      // Libera el slot que ocupaba el anfitrión (pudo haberse cambiado de
      // equipo con switchTeam() — regla 66 — así que NO asumimos home#0).
      if (conn.team === 'home') this.homeConns[conn.slot] = null;
      else if (conn.team === 'away') this.awayConns[conn.slot] = null;

      // Busca reemplazo entre los humanos que quedan (ya sin `conn`, que
      // acabamos de sacar de los arrays de arriba): home por índice
      // ascendente primero, si no hay nadie ahí entonces away por índice
      // ascendente. Promoción automática/determinística — sin votación.
      const replacement = this.homeConns.find(Boolean) || this.awayConns.find(Boolean) || null;

      if (replacement) {
        this.hostConn = replacement;
        // ws.role es una propiedad de conexión separada de this.hostConn,
        // asignada una sola vez en createRoom() (index.js). startMatch
        // valida ws.role !== 'host', así que hay que actualizarla aquí
        // también o el nuevo capitán jamás podría arrancar la partida.
        replacement.role = 'host';

        this.broadcast({
          type: 'hostChanged',
          team: replacement.team,
          slot: replacement.slot,
          username: replacement.username || 'Jugador',
        });
        this.broadcast({
          type: 'roomUpdate',
          format: this.format,
          slotsPerSide: this.slotsPerSide,
          participants: this.participants(),
          full: this.isFull(),
          hostTeam: this.hostConn.team,
          hostSlot: this.hostConn.slot,
        });
        return { removeRoom: false };
      }

      // Nadie más conectado: comportamiento actual, sin cambios.
      this._notifyOthers(conn, { type: 'opponentLeft' });
      this.stop();
      this.status = 'ended';
      return { removeRoom: true };
    }

    if (conn.team === 'home') this.homeConns[conn.slot] = null;
    else if (conn.team === 'away') this.awayConns[conn.slot] = null;
    this.broadcast({
      type: 'roomUpdate',
      format: this.format,
      slotsPerSide: this.slotsPerSide,
      participants: this.participants(),
      full: this.isFull(),
      hostTeam: this.hostConn.team,
      hostSlot: this.hostConn.slot,
    });
    return { removeRoom: false };
  }

  _notifyOthers(conn, obj) {
    const msg = JSON.stringify(obj);
    this.allConns().forEach((c) => {
      if (c === conn) return;
      try { if (c.readyState === 1) c.send(msg); } catch (e) {}
    });
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> MatchRoom
  }

  createRoom(hostConn, format, formationKey) {
    let code;
    do { code = genRoomCode(); } while (this.rooms.has(code));
    const room = new MatchRoom(code, hostConn, format, formationKey);
    this.rooms.set(code, room);
    return room;
  }

  joinRoom(code, guestConn) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'room_not_found' };
    if (room.status !== 'waiting') return { error: 'room_not_joinable' };
    const result = room.addGuest(guestConn);
    if (result.error) return result;
    return { room, team: result.team, slot: result.slot };
  }

  getRoom(code) {
    return this.rooms.get(code);
  }

  removeRoom(code) {
    const room = this.rooms.get(code);
    if (room) room.stop();
    this.rooms.delete(code);
  }

  // Limpieza periódica: salas 'waiting' abandonadas por más de 5 minutos.
  sweepStale() {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      if (room.status === 'waiting' && now - room.createdAt > 5 * 60 * 1000) {
        this.removeRoom(code);
      }
      if (room.status === 'ended') {
        this.removeRoom(code);
      }
    }
  }
}

module.exports = { RoomManager, MatchRoom, TICK_HZ, inputToVector, ARENA_FORMATIONS };
