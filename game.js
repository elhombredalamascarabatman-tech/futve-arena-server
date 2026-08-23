// ============================================================
// FUTVE ARENA — gestor de salas/partidas del servidor autoritativo.
// Cada MatchRoom controla un partido 1v1 entre dos sockets (host/guest).
// El servidor NUNCA acepta posiciones del cliente: solo botones de
// dirección (arriba/abajo/izquierda/derecha) y si mantiene pulsado el
// disparo. Todo lo demás (posición, física, goles, marcador, tiempo,
// resultado) lo calcula y decide este módulo.
// ============================================================

const { MatchSim, CONFIG } = require('./physics.js');

const TICK_HZ = 30; // pasos de física por segundo (servidor)
const TICK_DT = 1 / TICK_HZ;
const BROADCAST_EVERY_N_TICKS = 1; // 30Hz de estado hacia los clientes (partida 1v1, poco tráfico)

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

class MatchRoom {
  constructor(code, hostConn) {
    this.code = code;
    this.hostConn = hostConn;
    this.guestConn = null;
    this.sim = new MatchSim();
    this._inputHost = { x: 0, y: 0, shootPressed: false };
    this._inputGuest = { x: 0, y: 0, shootPressed: false };
    this._interval = null;
    this._tickCount = 0;
    this.status = 'waiting'; // waiting -> ready -> playing -> ended
    this.createdAt = Date.now();
  }

  setGuest(guestConn) {
    this.guestConn = guestConn;
    this.status = 'ready';
  }

  setInput(role, buttons) {
    const v = inputToVector(buttons);
    if (role === 'host') this._inputHost = v;
    else if (role === 'guest') this._inputGuest = v;
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    try { if (this.hostConn && this.hostConn.readyState === 1) this.hostConn.send(msg); } catch (e) {}
    try { if (this.guestConn && this.guestConn.readyState === 1) this.guestConn.send(msg); } catch (e) {}
  }

  start() {
    if (this.status !== 'ready') return false;
    this.status = 'playing';
    this.sim.start();
    this.broadcast({ type: 'matchStart' });
    this._interval = setInterval(() => this._tick(), TICK_DT * 1000);
    return true;
  }

  _tick() {
    if (this.status !== 'playing') return;
    const result = this.sim.tick(TICK_DT, this._inputHost, this._inputGuest);
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

  // Notifica al rival que el otro jugador se desconectó y termina la sala.
  handleDisconnect(role) {
    if (this.status === 'playing' || this.status === 'ready') {
      const other = role === 'host' ? this.guestConn : this.hostConn;
      try {
        if (other && other.readyState === 1) {
          other.send(JSON.stringify({ type: 'opponentLeft' }));
        }
      } catch (e) {}
    }
    this.stop();
    this.status = 'ended';
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> MatchRoom
  }

  createRoom(hostConn) {
    let code;
    do { code = genRoomCode(); } while (this.rooms.has(code));
    const room = new MatchRoom(code, hostConn);
    this.rooms.set(code, room);
    return room;
  }

  joinRoom(code, guestConn) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'room_not_found' };
    if (room.status !== 'waiting') return { error: 'room_not_joinable' };
    room.setGuest(guestConn);
    return { room };
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

module.exports = { RoomManager, MatchRoom, TICK_HZ, inputToVector };
