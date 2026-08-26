// ============================================================
// FUTVE ARENA — servidor WebSocket autoritativo.
// Usa el MISMO proyecto de Firebase que ya existe (gd-futve) para
// verificar quién es cada jugador: no crea ningún proyecto, hosting
// ni cuenta de usuarios nueva. Solo añade este backend para que el
// modo "Jugar en línea" de FUTVE Arena sea real, con el servidor
// validando toda la física importante (posiciones, balón, goles,
// tiempo, resultado) y sin confiar en nada que el cliente diga sobre
// su propia posición.
//
// Este archivo funciona igual en dos entornos de despliegue distintos:
//  - Cloud Run (dentro del mismo proyecto GCP): usa credenciales
//    automáticas del entorno, no requiere ninguna clave.
//  - Cualquier otro host fuera de Google (p.ej. Render): no hay
//    credenciales automáticas, así que se usa una clave de cuenta de
//    servicio de Firebase pegada en la variable de entorno
//    FIREBASE_SERVICE_ACCOUNT_JSON (ver COMO_PUBLICAR_SERVIDOR.md).
// ============================================================

const http = require('http');
const WebSocket = require('ws');
const { initializeApp, getApps, cert, applicationDefault } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { RoomManager, inputToVector } = require('./game.js');

if (getApps().length === 0) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    let svcAccount;
    try {
      svcAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      console.error('FIREBASE_SERVICE_ACCOUNT_JSON no es un JSON válido:', e.message);
      process.exit(1);
    }
    initializeApp({ credential: cert(svcAccount) });
  } else {
    // Sin la variable de entorno: asume que corre dentro de GCP (Cloud Run)
    // y usa las credenciales automáticas del entorno.
    initializeApp({ credential: applicationDefault() });
  }
}

const PORT = process.env.PORT || 8080;
const rooms = new RoomManager();

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('futve-arena-server ok\n');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server, path: '/ws' });

function send(ws, obj) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch (e) {}
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.uid = null;
  ws.username = null;
  ws.role = null; // 'host' | 'guest'
  ws.roomCode = null;
  ws.team = null; // 'home' | 'away' (asignado al crear/unirse a una sala)
  ws.slot = null; // índice dentro de ese equipo

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    try {
      switch (msg.type) {
        case 'auth': {
          if (typeof msg.idToken !== 'string' || !msg.idToken) {
            send(ws, { type: 'authError', message: 'Falta idToken.' });
            return;
          }
          try {
            // ARENA_TEST_MODE: SOLO para pruebas locales/CI sin credenciales reales
            // de Firebase (este sandbox no tiene acceso de red al proyecto real).
            // Nunca debe estar activo en Cloud Run/producción — allí siempre se
            // verifica el idToken real con firebase-admin.
            if (process.env.ARENA_TEST_MODE === '1') {
              ws.uid = String(msg.idToken).slice(0, 64) || 'test-uid';
            } else {
              const decoded = await getAuth().verifyIdToken(msg.idToken);
              ws.uid = decoded.uid;
            }
            ws.username = (typeof msg.username === 'string' && msg.username.slice(0, 40)) || 'Jugador';
            send(ws, { type: 'authOk', uid: ws.uid });
          } catch (e) {
            send(ws, { type: 'authError', message: 'Token inválido o expirado.' });
          }
          return;
        }

        case 'createRoom': {
          if (!ws.uid) { send(ws, { type: 'error', message: 'Debes autenticarte primero.' }); return; }
          const format = typeof msg.format === 'string' ? msg.format : '1v1';
          const formationKey = typeof msg.formationKey === 'string' ? msg.formationKey : null;
          const room = rooms.createRoom(ws, format, formationKey);
          ws.role = 'host';
          ws.roomCode = room.code;
          send(ws, { type: 'roomCreated', code: room.code, format: room.format, formationKey: room.formationKey, slotsPerSide: room.slotsPerSide, hostTeam: room.hostConn.team, hostSlot: room.hostConn.slot });
          return;
        }

        case 'joinRoom': {
          if (!ws.uid) { send(ws, { type: 'error', message: 'Debes autenticarte primero.' }); return; }
          const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
          if (!code) { send(ws, { type: 'error', message: 'Código de sala inválido.' }); return; }
          const result = rooms.joinRoom(code, ws);
          if (result.error === 'room_not_found') { send(ws, { type: 'error', message: 'No existe una sala con ese código.' }); return; }
          if (result.error === 'room_not_joinable') { send(ws, { type: 'error', message: 'Esa sala ya no admite jugadores.' }); return; }
          if (result.error === 'room_full') { send(ws, { type: 'error', message: 'Esa sala ya está completa.' }); return; }
          ws.role = 'guest';
          ws.roomCode = code;
          const room = result.room;
          send(ws, {
            type: 'roomJoined',
            code,
            format: room.format,
            formationKey: room.formationKey,
            slotsPerSide: room.slotsPerSide,
            team: result.team,
            slot: result.slot,
            hostUsername: room.hostConn.username,
            // Añadido para que el invitado pueda pintar el roster (y el
            // cambio de equipo) desde el primer instante, sin esperar a un
            // 'roomUpdate' posterior. Campo nuevo, puramente aditivo.
            participants: room.participants(),
            hostTeam: room.hostConn.team,
            hostSlot: room.hostConn.slot,
          });
          // 'guestJoined' se mantiene EXACTAMENTE como antes (mismo tipo, mismo
          // payload, solo al anfitrión) para 1v1 — es el contrato que ya usa
          // el cliente 1v1 (habilita el botón de empezar en la sala de
          // espera). Ahora que el cambio de equipo (regla 66) aplica también
          // a 1v1, ADEMÁS se difunde 'roomUpdate' con el roster completo a
          // TODOS los conectados (como ya se hacía solo para 4v4/7v7) — esto
          // es puramente aditivo, no reemplaza ni modifica 'guestJoined'.
          if (room.format === '1v1') {
            send(room.hostConn, { type: 'guestJoined', username: ws.username });
          }
          room.broadcast({ type: 'roomUpdate', format: room.format, slotsPerSide: room.slotsPerSide, participants: room.participants(), full: room.isFull(), hostTeam: room.hostConn.team, hostSlot: room.hostConn.slot });
          return;
        }

        case 'startMatch': {
          const room = ws.roomCode ? rooms.getRoom(ws.roomCode) : null;
          if (!room || ws.role !== 'host') { send(ws, { type: 'error', message: 'Solo el anfitrión puede iniciar la partida.' }); return; }
          const ok = room.start();
          if (!ok) send(ws, { type: 'error', message: 'La sala no está lista todavía.' });
          return;
        }

        case 'switchTeam': {
          // Regla 66: antes de arrancar, cualquier humano ya unido puede
          // cambiarse de equipo si hay hueco en el otro. Ver
          // MatchRoom.switchTeam() en game.js para el detalle de cómo se
          // reasigna (team, slot) y por qué el enrutado de 'input'
          // posterior no puede quedar apuntando a un slot viejo.
          const room = ws.roomCode ? rooms.getRoom(ws.roomCode) : null;
          if (!room) { send(ws, { type: 'error', message: 'No estás en ninguna sala.' }); return; }
          const result = room.switchTeam(ws);
          if (result.error === 'already_started') { send(ws, { type: 'error', message: 'La partida ya empezó: no puedes cambiar de equipo.' }); return; }
          if (result.error === 'team_full') { send(ws, { type: 'error', message: 'El otro equipo ya está completo.' }); return; }
          if (result.error === 'not_in_room') { send(ws, { type: 'error', message: 'No estás en ninguna sala.' }); return; }
          send(ws, { type: 'teamSwitched', team: result.team, slot: result.slot });
          room.broadcast({ type: 'roomUpdate', format: room.format, slotsPerSide: room.slotsPerSide, participants: room.participants(), full: room.isFull(), hostTeam: room.hostConn.team, hostSlot: room.hostConn.slot });
          return;
        }

        case 'rejoinRoom': {
          // Reconexión al mismo puesto (regla nueva): la sala sigue
          // 'playing', el slot de esta identidad (uid) se volvió bot al
          // desconectarse, y ahora reclama ese mismo (team, slot) de
          // vuelta. Usa 'rejoinFailed' (no el 'error' genérico) para TODOS
          // los fallos de esta operación: el cliente puede recibir esto
          // desde el menú principal de Arena, una pantalla que no tiene
          // ningún contexto de sala/lobby activo, así que necesita un tipo
          // propio que distinguir sin depender de qué pantalla está abierta.
          if (!ws.uid) { send(ws, { type: 'error', message: 'Debes autenticarte primero.' }); return; }
          const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
          const room = code ? rooms.getRoom(code) : null;
          if (!room) { send(ws, { type: 'rejoinFailed', message: 'No existe una sala con ese código.' }); return; }
          if (room.status !== 'playing') { send(ws, { type: 'rejoinFailed', message: 'Esa partida ya no está en curso.' }); return; }
          const result = room.reclaimSlot(ws);
          if (result.error === 'no_reclaim') {
            send(ws, { type: 'rejoinFailed', message: 'No hay ningún puesto tuyo esperando en esa partida (puede que ya lo hayas recuperado en otra pestaña, o que la partida haya terminado).' });
            return;
          }
          ws.role = 'guest';
          ws.roomCode = code;
          send(ws, { type: 'rejoinAccepted', code, ...result });
          return;
        }

        case 'input': {
          const room = ws.roomCode ? rooms.getRoom(ws.roomCode) : null;
          if (!room || !ws.role) return;
          // Solo se aceptan botones de dirección + estado de disparo — NUNCA
          // coordenadas. inputToVector() ignora cualquier otro campo del mensaje.
          // Se enruta por (team, slot) de ESTA conexión, asignado al unirse —
          // así cada humano mueve exactamente su propio disco, en cualquier formato.
          room.setInput(ws, msg.buttons);
          return;
        }

        case 'leave': {
          cleanupConnection(ws);
          return;
        }

        default:
          return;
      }
    } catch (e) {
      send(ws, { type: 'error', message: 'Error interno del servidor.' });
    }
  });

  ws.on('close', () => cleanupConnection(ws));
  ws.on('error', () => cleanupConnection(ws));
});

function cleanupConnection(ws) {
  if (!ws.roomCode) return;
  const room = rooms.getRoom(ws.roomCode);
  if (room) {
    const { removeRoom } = room.handleDisconnect(ws);
    if (removeRoom) rooms.removeRoom(ws.roomCode);
  }
  ws.roomCode = null;
  ws.role = null;
  ws.team = null;
  ws.slot = null;
}

// Ping/pong para detectar conexiones muertas (móviles que pierden la red, etc.)
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

// Limpieza de salas abandonadas.
const sweepInterval = setInterval(() => rooms.sweepStale(), 60000);

server.listen(PORT, () => {
  console.log(`FUTVE Arena server escuchando en puerto ${PORT}`);
});

process.on('SIGTERM', () => {
  clearInterval(pingInterval);
  clearInterval(sweepInterval);
  wss.clients.forEach((ws) => ws.terminate());
  server.close(() => process.exit(0));
});

module.exports = { server, wss, rooms };
