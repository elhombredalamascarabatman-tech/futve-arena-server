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
  // customPositions (pasada nueva — editor de formación): forwarded tal
  // cual a MatchSim, que es quien valida/usa de verdad (ver physics.js). Acá
  // solo se guarda el resultado (this.customPositions = this.sim.
  // customPositions, null si no aplicó) para poder incluirlo en los
  // broadcasts que ya exponían formationKey (matchStart, addSpectator,
  // reclaimSlot) — así un cliente (host, invitado, o espectador que se une
  // después) siempre puede pintar la formación real de la sala sin depender
  // de su propio localStorage.
  constructor(code, hostConn, format, formationKey, customPositions) {
    this.code = code;
    this.format = normalizeFormat(format);
    this.slotsPerSide = SLOTS_PER_SIDE[this.format];
    this.sim = new MatchSim(this.format, formationKey, customPositions);
    this.formationKey = this.sim.formationKey; // formato '1v1' -> null; si no, la formación realmente usada
    this.customPositions = this.sim.customPositions; // null salvo cuando se usó una formación personalizada válida

    this.hostConn = hostConn;
    this.homeConns = new Array(this.slotsPerSide).fill(null);
    this.awayConns = new Array(this.slotsPerSide).fill(null);
    this.homeConns[0] = hostConn;
    hostConn.team = 'home';
    hostConn.slot = 0;

    // Identidad (uid de Firebase) dueña de cada slot, en paralelo a
    // homeConns/awayConns pero que NO se borra cuando la conexión se cae —
    // a diferencia de homeConns/awayConns (que sí se ponen a null en una
    // desconexión), esto sobrevive mientras el partido siga 'playing', para
    // que reclaimSlot() pueda saber a quién le pertenece un slot que ahora
    // es bot. Se limpia explícitamente a null solo cuando el slot deja de
    // ser "reclamable" de verdad (se va alguien ANTES de que arranque la
    // partida — ver handleDisconnect, rama 'waiting').
    this.homeUids = new Array(this.slotsPerSide).fill(null);
    this.awayUids = new Array(this.slotsPerSide).fill(null);
    this.homeUids[0] = hostConn.uid;

    this._nextJoinTeam = 'away'; // política de alternancia, ver cabecera del archivo

    this._interval = null;
    this._tickCount = 0;
    this.status = 'waiting'; // waiting -> playing -> ended
    this.createdAt = Date.now();

    // Espectadores (modo espectador — pasada nueva): conexiones que solo
    // miran, nunca jugadores. Deliberadamente separado de homeConns/
    // awayConns: no ocupan slot, no cuentan para humanCount()/isFull(), y no
    // se les asigna conn.team/conn.slot (quedan undefined/null), así todo el
    // código existente que depende de conn.team/conn.slot para decidir "es
    // un jugador de verdad" (setInput, switchTeam, reclaimSlot, etc.) sigue
    // funcionando sin tocarlo — ver addSpectator() más abajo.
    this.spectators = [];

    // Votación de capitán de la sala (pasada nueva — ver informe). Solo
    // puede existir UNA vez a la vez (this.captainVote es null o el objeto
    // de la votación activa) y solo mientras this.status === 'waiting'.
    // Forma de this.captainVote cuando hay una votación activa:
    //   { candidates: [{team,slot,uid,username,conn}], votesByUid: Map<uid,
    //     "team:slot">, durationMs, endsAt, timer }
    // votesByUid guarda el ÚLTIMO voto de cada uid (Map.set sobreescribe),
    // así "cambiar el voto antes de que termine" (pedido explícito del
    // dueño) sale gratis con la estructura de datos correcta, sin lógica
    // aparte.
    this.captainVote = null;
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
      const uids = team === 'home' ? this.homeUids : this.awayUids;
      uids[slot] = guestConn.uid;
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
    const fromUids = fromTeam === 'home' ? this.homeUids : this.awayUids;
    const toUids = toTeam === 'home' ? this.homeUids : this.awayUids;

    const targetSlot = toConns.findIndex((c) => c === null);
    if (targetSlot === -1) return { error: 'team_full' };

    // Confirma que conn de verdad está donde dice estar antes de tocar nada
    // (defensivo — no debería poder desalinearse, pero evita corromper el
    // array si alguna llamada futura pasa una conn ya obsoleta).
    if (fromConns[conn.slot] !== conn) return { error: 'not_in_room' };

    fromConns[conn.slot] = null;
    fromUids[conn.slot] = null;
    toConns[targetSlot] = conn;
    toUids[targetSlot] = conn.uid;
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

  // ============================================================
  // VOTACIÓN DE CAPITÁN DE LA SALA (pasada nueva).
  //
  // Alcance: SIEMPRE una sola sala (este ARENAFUT room), nunca una
  // "jornada"/temporada — no existe ningún concepto de liga/copa/torneo en
  // este proyecto y esta votación no lo introduce. Solo puede arrancarla el
  // anfitrión actual, solo mientras this.status === 'waiting', y solo si hay
  // al menos 2 participantes reales conectados (host incluido). Los
  // candidatos son una FOTO tomada en el instante de arrancar — quien se une
  // después ya no entra como candidato, pero SÍ puede votar por alguno de
  // los que ya estaban (ver castVote).
  //
  // Decisión documentada — ¿pueden votar los espectadores?: SÍ. Mirar una
  // votación de capitán de una sala ajena y no poder participar se sintió
  // más arbitrario que útil, y no hay ningún riesgo de integridad del
  // partido en juego (los espectadores nunca controlan un disco ni afectan
  // la física) — así que cualquier conexión ya identificada en esta sala,
  // sea jugador o espectador, tiene un voto.
  //
  // Decisión documentada — empate: gana el anfitrión ACTUAL si está entre
  // los empatados y sigue conectado; si no, gana el candidato conectado que
  // apareció primero en el snapshot de candidatos (orden de participants():
  // home ascendente por slot, luego away ascendente por slot) — un orden
  // determinístico y reproducible, no un sorteo.
  //
  // Decisión documentada — candidato desconectado a mitad de votación: sus
  // votos SIGUEN contando (no se le retiran), pero si termina siendo el más
  // votado y ya no está conectado en el mismo (team, slot) del snapshot, NO
  // se le reasigna el capitanazgo a un slot vacío/ajeno — se pasa al
  // siguiente candidato más votado que sí siga conectado. Si ningún
  // candidato con votos sigue conectado, la votación termina sin ganador
  // (el capitán actual se queda como está).
  _voteKey(team, slot) { return team + ':' + slot; }

  // Host-only (verificado en index.js vía ws.role === 'host', igual que
  // start()). Devuelve {ok:true} o {error:'not_waiting'|'vote_active'|
  // 'not_enough_players'}.
  startCaptainVote() {
    if (this.status !== 'waiting') return { error: 'not_waiting' };
    if (this.captainVote) return { error: 'vote_active' };

    const candidates = this.participants().map((p) => {
      const conns = p.team === 'home' ? this.homeConns : this.awayConns;
      const conn = conns[p.slot];
      return { team: p.team, slot: p.slot, uid: conn.uid, username: p.username, conn };
    });
    if (candidates.length < 2) return { error: 'not_enough_players' };

    const durationMs = 20000; // 20s fijos, autoritativo en servidor — ver informe.
    const endsAt = Date.now() + durationMs;
    this.captainVote = {
      candidates,
      votesByUid: new Map(),
      durationMs,
      endsAt,
      timer: setTimeout(() => this._endCaptainVote(false), durationMs),
    };

    this.broadcast({
      type: 'captainVoteStarted',
      candidates: candidates.map((c) => ({ team: c.team, slot: c.slot, uid: c.uid, username: c.username })),
      durationMs,
      endsAt,
    });
    return { ok: true };
  }

  // Cualquier conexión ya identificada en la sala (jugador o espectador,
  // decisión documentada arriba) puede votar por cualquier candidato del
  // snapshot, incluido a sí misma. Un voto repetido de la misma uid
  // reemplaza al anterior (Map.set) — "cambiar el voto" sale gratis.
  // Devuelve {ok:true} o {error:'no_active_vote'|'not_in_room'|'invalid_candidate'}.
  castVote(conn, candidateTeam, candidateSlot) {
    if (!this.captainVote) return { error: 'no_active_vote' };
    if (!conn.uid) return { error: 'not_in_room' };
    const isPlayer = this.allConns().includes(conn);
    const isSpectator = this.spectators.includes(conn);
    if (!isPlayer && !isSpectator) return { error: 'not_in_room' };

    const candidate = this.captainVote.candidates.find(
      (c) => c.team === candidateTeam && c.slot === candidateSlot
    );
    if (!candidate) return { error: 'invalid_candidate' };

    this.captainVote.votesByUid.set(conn.uid, this._voteKey(candidateTeam, candidateSlot));
    this._broadcastCaptainVoteUpdate();
    return { ok: true };
  }

  // Tabulado en vivo (conteos únicamente — no se difunde quién votó a quién,
  // decisión documentada: mantiene el payload simple y evita cualquier duda
  // de "voto secreto" dentro de un grupo de amigos jugando la misma sala).
  _tallyCaptainVote() {
    const vote = this.captainVote;
    const counts = new Map();
    vote.candidates.forEach((c) => counts.set(this._voteKey(c.team, c.slot), 0));
    for (const key of vote.votesByUid.values()) {
      if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    }
    return vote.candidates.map((c) => ({
      team: c.team,
      slot: c.slot,
      uid: c.uid,
      username: c.username,
      votes: counts.get(this._voteKey(c.team, c.slot)) || 0,
    }));
  }

  _broadcastCaptainVoteUpdate() {
    if (!this.captainVote) return;
    const tally = this._tallyCaptainVote();
    this.broadcast({
      type: 'captainVoteUpdate',
      tally,
      totalVotes: this.captainVote.votesByUid.size,
    });
  }

  // Snapshot para alguien que se une a una sala CON una votación ya en
  // curso (join a mitad de votación): le permite a su cliente pintar el
  // panel de votación de una, sin esperar al próximo captainVoteUpdate.
  captainVoteSnapshot() {
    if (!this.captainVote) return null;
    return {
      candidates: this.captainVote.candidates.map((c) => ({ team: c.team, slot: c.slot, uid: c.uid, username: c.username })),
      durationMs: this.captainVote.durationMs,
      endsAt: this.captainVote.endsAt,
      tally: this._tallyCaptainVote(),
    };
  }

  // Determina si un candidato del snapshot sigue realmente conectado EN EL
  // MISMO (team, slot) que tenía cuando arrancó la votación — igual que el
  // resto del archivo, se compara la referencia de conexión exacta (no solo
  // el uid), así que un reemplazo de ese slot por otra persona (no debería
  // poder pasar en 'waiting' sin pasar antes por handleDisconnect) tampoco
  // cuenta como "el candidato original sigue ahí".
  _captainCandidateStillConnected(c) {
    const conns = c.team === 'home' ? this.homeConns : this.awayConns;
    return conns[c.slot] === c.conn && c.conn.readyState === 1;
  }

  // Cierra la votación (por timeout real o por cancelación forzada — ver
  // handleDisconnect). cancelled=true se usa EXCLUSIVAMENTE cuando el
  // anfitrión se desconecta a mitad de votación y la promoción automática
  // (red de seguridad existente, ver handleDisconnect) ya resolvió quién
  // manda — en ese caso no se tabula nada ni se reasigna nada más, solo se
  // avisa a todos que la votación quedó sin efecto.
  _endCaptainVote(cancelled) {
    if (!this.captainVote) return;
    const vote = this.captainVote;
    if (vote.timer) clearTimeout(vote.timer);
    this.captainVote = null;

    if (cancelled) {
      this.broadcast({ type: 'captainVoteEnded', cancelled: true, tally: [], winner: null });
      return;
    }

    const counts = new Map();
    vote.candidates.forEach((c) => counts.set(this._voteKey(c.team, c.slot), 0));
    for (const key of vote.votesByUid.values()) {
      if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    }
    const votesOf = (c) => counts.get(this._voteKey(c.team, c.slot)) || 0;
    const maxVotes = vote.candidates.reduce((m, c) => Math.max(m, votesOf(c)), 0);

    let winnerCandidate = null;
    if (maxVotes > 0) {
      const tied = vote.candidates.filter((c) => votesOf(c) === maxVotes);
      const hostTied = tied.find(
        (c) => c.team === this.hostConn.team && c.slot === this.hostConn.slot
      );
      if (hostTied && this._captainCandidateStillConnected(hostTied)) {
        winnerCandidate = hostTied;
      } else {
        winnerCandidate = tied.find((c) => this._captainCandidateStillConnected(c)) || null;
      }
      // Ningún empatado sigue conectado: cae al siguiente más votado (de
      // entre TODOS los candidatos, no solo los empatados en el máximo) que
      // siga conectado y tenga al menos un voto — ver decisión documentada
      // arriba sobre "candidato desconectado a mitad de votación".
      if (!winnerCandidate) {
        const byVotesDesc = vote.candidates.slice().sort((a, b) => votesOf(b) - votesOf(a));
        winnerCandidate = byVotesDesc.find((c) => votesOf(c) > 0 && this._captainCandidateStillConnected(c)) || null;
      }
    }

    const tally = vote.candidates.map((c) => ({
      team: c.team, slot: c.slot, uid: c.uid, username: c.username, votes: votesOf(c),
    }));

    if (winnerCandidate) {
      const alreadyHost = this.hostConn.team === winnerCandidate.team && this.hostConn.slot === winnerCandidate.slot;
      if (!alreadyHost) {
        // Mismo camino EXACTO que la reasignación automática por
        // desconexión (ver handleDisconnect más abajo): reutiliza
        // 'hostChanged'/'roomUpdate' tal cual, para que la corona/badge
        // "ANFITRIÓN" del cliente se actualice sin ningún código nuevo.
        this.hostConn = winnerCandidate.conn;
        winnerCandidate.conn.role = 'host';
        this.broadcast({
          type: 'hostChanged',
          team: winnerCandidate.team,
          slot: winnerCandidate.slot,
          username: winnerCandidate.conn.username || 'Jugador',
          reason: 'vote',
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
      }
    }

    this.broadcast({
      type: 'captainVoteEnded',
      cancelled: false,
      tally,
      winner: winnerCandidate
        ? { team: winnerCandidate.team, slot: winnerCandidate.slot, uid: winnerCandidate.uid, username: winnerCandidate.username }
        : null,
    });
  }

  // Modo espectador (pasada nueva): agrega `conn` a la lista de miradores de
  // esta sala. Sin límite de cupo — los espectadores no ocupan un slot, así
  // que no hay noción de "sala llena" que les aplique. A propósito NO se le
  // asigna conn.team/conn.slot (quedan undefined/null): así setInput()
  // ignora en silencio cualquier 'input' que mande (conn.team es falsy),
  // switchTeam() devuelve {error:'not_in_room'} si lo intenta, y
  // reclaimSlot() nunca lo encuentra en homeUids/awayUids. Ningún método de
  // asignación de slots necesita cambios.
  // Devuelve el snapshot completo que el cliente necesita para pintar la
  // pantalla correcta de una (sala de espera o partido en curso).
  addSpectator(conn) {
    this.spectators.push(conn);
    conn.role = 'spectator';
    conn.roomCode = this.code;
    return {
      format: this.format,
      formationKey: this.formationKey,
      customPositions: this.customPositions,
      slotsPerSide: this.slotsPerSide,
      status: this.status,
      participants: this.participants(),
      hostTeam: this.hostConn.team,
      hostSlot: this.hostConn.slot,
      scoreHome: this.sim.scoreHome,
      scoreAway: this.sim.scoreAway,
      timeLeft: this.sim.timeLeft,
      state: this.status === 'playing' ? this.sim.getSnapshot() : null,
      // Votación de capitán ya en curso (pasada nueva): permite pintar el
      // panel de votación de una si alguien entra a mitad de votación, sin
      // esperar al próximo captainVoteUpdate.
      activeCaptainVote: this.captainVoteSnapshot(),
    };
  }

  setInput(conn, buttons) {
    if (!conn.team || conn.slot == null) return;
    const v = inputToVector(buttons);
    this.sim.setInput(conn.team, conn.slot, v);
  }

  // Reconexión al mismo puesto (mitad de partido, regla nueva). Busca entre
  // homeUids/awayUids un slot cuyo dueño registrado sea conn.uid Y que en
  // este momento sea un slot-bot de verdad (isBotSlot) — esto último es
  // defensivo: si por algún motivo ya hay un humano ahí (no debería poder
  // pasar en el flujo normal), no lo pisa. Nota de diseño deliberada: NO se
  // reconcilia this.hostConn/rol de anfitrión aquí — a mitad de partido
  // startMatch ya se usó y ninguna acción restante depende de 'role' o de
  // quién sea this.hostConn, así que un anfitrión reconectado NO recupera
  // el rol de capitán si ya fue reemplazado por la reasignación automática
  // (pasada anterior). Queda así a propósito, no es un descuido.
  reclaimSlot(conn) {
    if (this.status !== 'playing') return { error: 'not_playing' };

    const findSlot = (uids, team) => {
      for (let slot = 0; slot < uids.length; slot++) {
        if (uids[slot] === conn.uid && this.sim.isBotSlot(team, slot)) return slot;
      }
      return -1;
    };

    let team = 'home';
    let slot = findSlot(this.homeUids, 'home');
    if (slot === -1) { team = 'away'; slot = findSlot(this.awayUids, 'away'); }
    if (slot === -1) return { error: 'no_reclaim' };

    const conns = team === 'home' ? this.homeConns : this.awayConns;
    conns[slot] = conn;
    conn.team = team;
    conn.slot = slot;
    this.sim.convertToHuman(team, slot);

    this._notifyOthers(conn, {
      type: 'slotReclaimed',
      team,
      slot,
      username: conn.username || 'Jugador',
    });

    return {
      team,
      slot,
      format: this.format,
      formationKey: this.formationKey,
      customPositions: this.customPositions,
      slotsPerSide: this.slotsPerSide,
      scoreHome: this.sim.scoreHome,
      scoreAway: this.sim.scoreAway,
      timeLeft: this.sim.timeLeft,
      hostTeam: this.hostConn.team,
      hostSlot: this.hostConn.slot,
    };
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    // allConns() sigue siendo SOLO jugadores (isFull()/humanCount()/reparto
    // de slots dependen de eso) — los espectadores se agregan aparte aquí,
    // puramente para que también reciban todo lo que ya se difunde a todos.
    this.allConns().concat(this.spectators).forEach((c) => {
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
      customPositions: this.customPositions,
      homeBotSlots, awayBotSlots,
    });
    this._interval = setInterval(() => this._tick(), TICK_DT * 1000);
    return true;
  }

  _tick() {
    if (this.status !== 'playing') return;
    try {
      // SOLO para pruebas locales/CI (ARENA_TEST_MODE=1): permite a un QA
      // script forzar una excepción real dentro del tick de ESTA sala, para
      // verificar que el aislamiento de fallos (try/catch de abajo) termina
      // únicamente esta sala y no tumba el proceso para el resto de salas.
      // Nunca alcanzable fuera de test mode.
      if (process.env.ARENA_TEST_MODE === '1' && this._debugForceTickThrow) {
        this._debugForceTickThrow = false;
        throw new Error('debugForceTickThrow: fallo forzado de prueba');
      }

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
    } catch (err) {
      // Aislamiento de fallos: un error en la física/IA de ESTA sala no debe
      // tumbar el proceso ni afectar a ninguna otra sala. Se registra, se
      // avisa a los clientes de esta sala (si es posible) y se termina solo
      // esta sala de forma limpia, reutilizando el mismo camino de fin de
      // partida que 'ended' usa arriba (status='ended' + stop()).
      console.error(`[Room ${this.code}] Error no controlado en _tick(), terminando esta sala:`, err);
      try {
        this.broadcast({ type: 'error', message: 'Error interno del servidor. La partida ha finalizado.' });
      } catch (broadcastErr) {
        console.error(`[Room ${this.code}] Error adicional al notificar a los clientes:`, broadcastErr);
      }
      this.status = 'ended';
      this.stop();
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
    // Un espectador desconectándose nunca es un jugador que se va: no debe
    // disparar reasignación de anfitrión, conversión a bot, ni ningún otro
    // efecto sobre la partida real. Se revisa ANTES que cualquier otra rama.
    const specIdx = this.spectators.indexOf(conn);
    if (specIdx !== -1) {
      this.spectators.splice(specIdx, 1);
      return { removeRoom: false };
    }

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
      // Votación de capitán en curso (pasada nueva) + el anfitrión se
      // desconecta: la red de seguridad existente (promoción automática/
      // determinística, ver más abajo) SIEMPRE gana — se cancela la
      // votación de inmediato (broadcast 'captainVoteEnded' con
      // cancelled:true, sin ganador-por-voto) para no dejarla viva ni
      // arriesgar una doble reasignación de anfitrión. Se hace ANTES de
      // calcular el reemplazo para que quede irrelevante si termina
      // habiendo reemplazo o no (ambos casos cancelan la votación igual).
      if (this.captainVote) this._endCaptainVote(true);

      // Libera el slot que ocupaba el anfitrión (pudo haberse cambiado de
      // equipo con switchTeam() — regla 66 — así que NO asumimos home#0).
      // También limpia homeUids/awayUids: el anfitrión que se fue ANTES de
      // arrancar la partida no debería poder "reclamar" nada más tarde con
      // rejoinRoom — nunca llegó a jugar esta partida.
      if (conn.team === 'home') { this.homeConns[conn.slot] = null; this.homeUids[conn.slot] = null; }
      else if (conn.team === 'away') { this.awayConns[conn.slot] = null; this.awayUids[conn.slot] = null; }

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
          reason: 'disconnect',
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

    // Mismo motivo que arriba: alguien que se va ANTES de arrancar no debe
    // poder reclamar ese slot después (p.ej. si termina siendo un slot-bot
    // en la partida real que arranca luego con otra gente) — nunca llegó a
    // jugarla.
    if (conn.team === 'home') { this.homeConns[conn.slot] = null; this.homeUids[conn.slot] = null; }
    else if (conn.team === 'away') { this.awayConns[conn.slot] = null; this.awayUids[conn.slot] = null; }
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
    // Mismo criterio que broadcast(): también llega a los espectadores
    // (menos `conn` mismo, igual que ya hacía con los jugadores).
    this.allConns().concat(this.spectators).forEach((c) => {
      if (c === conn) return;
      try { if (c.readyState === 1) c.send(msg); } catch (e) {}
    });
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> MatchRoom
  }

  createRoom(hostConn, format, formationKey, customPositions) {
    let code;
    do { code = genRoomCode(); } while (this.rooms.has(code));
    const room = new MatchRoom(code, hostConn, format, formationKey, customPositions);
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
