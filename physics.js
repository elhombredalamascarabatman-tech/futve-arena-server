// ============================================================
// FUTVE ARENA — motor de física puro para el servidor (sin DOM,
// sin canvas). Es un puerto fiel de la física del cliente
// (mismos valores de ARENA_CONFIG, mismas fórmulas) para que jugar
// en línea se sienta IGUAL que jugar contra la IA localmente.
// El servidor es la única autoridad: nunca confía en posiciones que
// mande un cliente, solo en su INPUT (dirección + si dispara).
//
// Generalizado a N-vs-N (4v4/7v7) además del 1v1 original: MatchSim
// ahora maneja homeSquad/awaySquad (arrays de Player) en vez de un
// único home/away. El caso '1v1' se construye exactamente igual que
// antes (mismos puntos de partida 0.25/0.75 del campo) y su snapshot
// mantiene la MISMA forma de siempre (state.home/state.away objetos
// sueltos) para no tocar el contrato ya probado con el cliente.
// ============================================================
 
const CONFIG = {
  // GOAL_POST_RADIUS: radio del disco de colisión de cada poste (gap #1 del
  // audit — antes no existía ningún collider de poste, la boca de gol era
  // un simple hueco en la pared). Deliberadamente NO depende del formato
  // (regla: sin constantes de física condicionales por formato) — mismo
  // radio en 1v1/4v4/7v7 aunque GOAL_WIDTH cambie entre formatos.
  FIELD: { WIDTH: 900, HEIGHT: 560, GOAL_WIDTH: 140, GOAL_DEPTH: 22, GOAL_POST_RADIUS: 7 },
  PLAYER: {
    RADIUS: 14,
    SPEED: 220,
    ACCEL: 2000, // pasada nueva: 1400 -> 2000 (llega a SPEED en ~0.11s en vez de ~0.157s, "pulso -> me muevo" más inmediato)
    FRICTION: 25, // pasada nueva: 10 -> 25 (frenado total desde SPEED en ~185ms en vez de ~430ms — "rápida y precisa, no resbaladiza")
    KICK_RANGE: 26,
    MIN_SHOT_POWER: 330,
    MAX_SHOT_POWER: 640,
    CHARGE_MS: 420,
    DRIBBLE_PUSH_ACCEL: 820,
    POSSESSION_RANGE: 30,
    TACKLE_RANGE: 22,
    TACKLE_CHANCE_PER_SEC: 1.3,
    TACKLE_IMPULSE: 170,
    // --- Colisión jugador-jugador (pasada nueva — gap #1 de "feel" del
    // audit): antes de esto la colisión era puramente posicional (cero
    // cambio de velocidad). COLLISION_BOUNCE es el coeficiente de rebote
    // del impulso elástico simple (0 = totalmente inelástico/solo se
    // separan, 1 = rebote elástico completo); COLLISION_IMPULSE_MAX topea
    // la magnitud del impulso para que un choque de frente a máxima
    // velocidad nunca sea explosivo/inestable (ver _resolvePlayerCollision).
    COLLISION_BOUNCE: 0.4,
    COLLISION_IMPULSE_MAX: 140,
    // Cooldown mínimo (ms) entre dos golpes de balón (disparo o pase) del
    // MISMO jugador — evita el tap-fire repetido sin límite. Comparte
    // el mismo reloj de _elapsedMs que el resto de la simulación (nunca
    // Date.now()), para que sea determinístico.
    SHOT_COOLDOWN_MS: 150,
  },
  BALL: { RADIUS: 9, FRICTION: 0.985, MIN_SPEED: 4, WALL_BOUNCE: 0.75 },
  // Puerto fiel de ARENA_CONFIG.AI del cliente (solo los campos que usa
  // el bot de zona server-side, ZoneAIController — ver más abajo). Los
  // mismos números que el cliente para que 4v4/7v7 en línea se sienta
  // igual que 4v4/7v7 local vs IA.
  AI: {
    KICK_RANGE: 26,
    SHOT_POWER: 440,
    SHOT_POWER_VARIANCE: 0.18,
    SHOOT_X_LIMIT: 520,
    CHASE_REACTION_DIST: 380,
    STEER_SMOOTHING: 10,
    ZONE_SHIFT_MAX: 90,
    PASS_DECISION_MIN_MS: 300,
    PASS_DECISION_MAX_MS: 500,
    PASS_MIN_DIST: 70,
    PASS_MAX_DIST: 420,
    PASS_MARK_TOO_TIGHT: 55,
    PASS_SKIP_CHANCE: 0.35,
    PASS_SUBOPTIMAL_CHANCE: 0.4,
    PASS_AIM_ERROR_RAD: 0.22,
    PASS_POWER_MIN: 200,
    PASS_POWER_MAX: 380,
    PASS_POWER_DIST_REF: 380,
  },
  // Duración real del partido: 120s, igual que en el cliente. Se puede
  // sobreescribir solo vía variable de entorno (usado en pruebas locales
  // para no esperar 2 minutos reales); en producción no se define y se
  // usa siempre el valor real.
  MATCH: { DURATION_SECONDS: Number(process.env.ARENA_MATCH_DURATION_SECONDS) || 120 },
};
 
// ============================================================
// FORMATOS (4v4/7v7) — mismos datos que ARENA_FORMAT_FIELD_SIZES /
// ARENA_FORMATIONS del cliente (index.html). Dato puro (posiciones
// fraccionales 0..1, defensa->ataque); se mantiene deliberadamente
// idéntico entre cliente y servidor para que una partida 4v4/7v7 en
// línea se vea/sienta igual que la misma partida local vs IA. El
// formato '1v1' NO tiene entrada aquí a propósito — sigue usando
// siempre CONFIG.FIELD tal cual (ver MatchSim constructor).
// ============================================================
const ARENA_FORMAT_FIELD_SIZES = {
  '4v4': { WIDTH: 760, HEIGHT: 620, GOAL_WIDTH: 155, GOAL_DEPTH: 22 },
  '7v7': { WIDTH: 1300, HEIGHT: 760, GOAL_WIDTH: 190, GOAL_DEPTH: 24 },
};
 
const ARENA_FORMATIONS = {
  '4v4': {
    '1-2-1': [ { x: 0.14, y: 0.50 }, { x: 0.38, y: 0.28 }, { x: 0.38, y: 0.72 }, { x: 0.64, y: 0.50 } ],
    '2-1-1': [ { x: 0.16, y: 0.30 }, { x: 0.16, y: 0.70 }, { x: 0.42, y: 0.50 }, { x: 0.66, y: 0.50 } ],
    '1-1-2': [ { x: 0.16, y: 0.50 }, { x: 0.42, y: 0.50 }, { x: 0.64, y: 0.30 }, { x: 0.64, y: 0.70 } ],
    '2-2':   [ { x: 0.22, y: 0.30 }, { x: 0.22, y: 0.70 }, { x: 0.56, y: 0.30 }, { x: 0.56, y: 0.70 } ],
  },
  '7v7': {
    '2-3-1': [ { x: 0.08, y: 0.50 }, { x: 0.24, y: 0.30 }, { x: 0.24, y: 0.70 }, { x: 0.46, y: 0.18 }, { x: 0.46, y: 0.50 }, { x: 0.46, y: 0.82 }, { x: 0.68, y: 0.50 } ],
    '3-2-1': [ { x: 0.08, y: 0.50 }, { x: 0.24, y: 0.18 }, { x: 0.24, y: 0.50 }, { x: 0.24, y: 0.82 }, { x: 0.46, y: 0.32 }, { x: 0.46, y: 0.68 }, { x: 0.68, y: 0.50 } ],
    '3-3':   [ { x: 0.08, y: 0.50 }, { x: 0.24, y: 0.18 }, { x: 0.24, y: 0.50 }, { x: 0.24, y: 0.82 }, { x: 0.55, y: 0.18 }, { x: 0.55, y: 0.50 }, { x: 0.55, y: 0.82 } ],
    '2-2-2': [ { x: 0.08, y: 0.50 }, { x: 0.24, y: 0.30 }, { x: 0.24, y: 0.70 }, { x: 0.46, y: 0.30 }, { x: 0.46, y: 0.70 }, { x: 0.66, y: 0.30 }, { x: 0.66, y: 0.70 } ],
  },
};
 
class Field {
  // `overrides` opcional: parche parcial sobre CONFIG.FIELD para campos
  // de otro tamaño (4v4/7v7). Sin argumento, exactamente el campo 1v1 de
  // siempre.
  constructor(overrides) {
    const F = overrides ? Object.assign({}, CONFIG.FIELD, overrides) : CONFIG.FIELD;
    this.width = F.WIDTH;
    this.height = F.HEIGHT;
    this.goalWidth = F.GOAL_WIDTH;
    this.goalDepth = F.GOAL_DEPTH;
    this.goalPostRadius = F.GOAL_POST_RADIUS;
    this.goalTop = (this.height - this.goalWidth) / 2;
    this.goalBottom = this.goalTop + this.goalWidth;
    // Los 4 postes (colisionador circular) en las 2 esquinas de cada boca de
    // gol — ver Ball.handlePosts(). Puramente geométrico, calculado una vez.
    this.posts = [
      { x: 0, y: this.goalTop },
      { x: 0, y: this.goalBottom },
      { x: this.width, y: this.goalTop },
      { x: this.width, y: this.goalBottom },
    ];
  }
  checkGoal(ball) {
    const withinGoalMouth = ball.y > this.goalTop && ball.y < this.goalBottom;
    if (!withinGoalMouth) return null;
    if (ball.x - ball.radius > this.width) return 'home'; // pasó de largo a la derecha: gol del equipo home
    if (ball.x + ball.radius < 0) return 'away';
    return null;
  }
}
 
class Ball {
  constructor(field) {
    this.field = field;
    this.radius = CONFIG.BALL.RADIUS;
    this.owner = null;       // 'home' | 'away' | null (compat con el snapshot 1v1 de siempre)
    this.ownerPlayer = null; // referencia directa al Player poseedor (usado por N-vs-N)
    this.reset();
  }
  reset() {
    this.x = this.field.width / 2;
    this.y = this.field.height / 2;
    this.vx = 0; this.vy = 0;
    this.owner = null;
    this.ownerPlayer = null;
  }
  kick(dirX, dirY, power) {
    const len = Math.hypot(dirX, dirY) || 1;
    this.vx = (dirX / len) * power;
    this.vy = (dirY / len) * power;
    this.owner = null;
    this.ownerPlayer = null;
  }
  update(dt) {
    const f = Math.pow(CONFIG.BALL.FRICTION, dt * 60);
    this.vx *= f;
    this.vy *= f;
    if (Math.hypot(this.vx, this.vy) < CONFIG.BALL.MIN_SPEED) { this.vx = 0; this.vy = 0; }
 
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.handlePosts();
    this.handleWalls();
  }
 
  // GAP #1 del audit: colisión de balón contra los postes (antes la boca de
  // gol era un simple hueco en handleWalls() — un disparo podía "cruzar" por
  // donde estaría un poste real sin que nada lo detuviera). Cada poste es un
  // disco pequeño (F.goalPostRadius) en las 2 esquinas de cada boca de gol.
  // Corrección anti-tunneling (empuja el balón fuera del solape) + reflexión
  // de velocidad estándar sobre la normal de colisión, escalada por
  // WALL_BOUNCE (mismo "feel" de rebote que el resto del campo). Solo
  // refleja si el balón se mueve HACIA el poste (v·n < 0): si ya se está
  // separando, no se toca la velocidad (evita vibración/rebote fantasma).
  // Un balón que cruza por el MEDIO de la boca de gol nunca entra en el
  // radio de ningún poste, así que checkGoal() no se ve afectado.
  handlePosts() {
    const F = this.field;
    const bounce = CONFIG.BALL.WALL_BOUNCE;
    const minDist = this.radius + F.goalPostRadius;
    for (const post of F.posts) {
      const dx = this.x - post.x, dy = this.y - post.y;
      const dist = Math.hypot(dx, dy) || 0.0001;
      if (dist >= minDist) continue;
      const nx = dx / dist, ny = dy / dist;
      // Anti-tunneling: saca el balón del solape a lo largo de la normal.
      const overlap = minDist - dist;
      this.x += nx * overlap;
      this.y += ny * overlap;
      // Reflexión de velocidad sobre la normal (estándar: v' = v - (1+bounce)(v·n)n),
      // solo si va hacia el poste.
      const vDotN = this.vx * nx + this.vy * ny;
      if (vDotN < 0) {
        const k = (1 + bounce) * vDotN;
        this.vx -= k * nx;
        this.vy -= k * ny;
      }
    }
  }
 
  handleWalls() {
    const F = this.field;
    const r = this.radius;
    const bounce = CONFIG.BALL.WALL_BOUNCE;
    const insideGoalMouthY = this.y > F.goalTop && this.y < F.goalBottom;
 
    if (this.y - r < 0) { this.y = r; this.vy = Math.abs(this.vy) * bounce; }
    else if (this.y + r > F.height) { this.y = F.height - r; this.vy = -Math.abs(this.vy) * bounce; }
 
    if (!insideGoalMouthY) {
      if (this.x - r < 0) { this.x = r; this.vx = Math.abs(this.vx) * bounce; }
      else if (this.x + r > F.width) { this.x = F.width - r; this.vx = -Math.abs(this.vx) * bounce; }
    } else {
      // Dentro de la boca de gol: dejar pasar el balón, pero rebotar en el fondo de la red.
      if (this.x - r < -F.goalDepth) { this.x = -F.goalDepth + r; this.vx = Math.abs(this.vx) * bounce; }
      else if (this.x + r > F.width + F.goalDepth) { this.x = F.width + F.goalDepth - r; this.vx = -Math.abs(this.vx) * bounce; }
    }
  }
}
 
class Player {
  constructor(field, x, y) {
    this.field = field;
    this.radius = CONFIG.PLAYER.RADIUS;
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.facingX = 1; this.facingY = 0;
    this.chargeRatio = 0;
    // Metadatos de formación (solo N-vs-N; sin uso en 1v1). Puramente
    // informativos/posicionales, regla 91: ningún jugador/slot tiene
    // capacidad especial por esto.
    this.number = null;
    this.zoneX = x; this.zoneY = y;
    // Reloj propio de la simulación (this._elapsedMs de MatchSim, nunca
    // Date.now()) de la última vez que este jugador golpeó el balón (tiro
    // o pase) — usado por SHOT_COOLDOWN_MS para evitar el tap-fire sin
    // límite. -Infinity al arrancar: el primer golpe nunca está en cooldown.
    this._lastShotAt = -Infinity;
  }
  // ¿Ya pasó el cooldown mínimo desde el último golpe de balón? nowMs es el
  // reloj de la simulación (MatchSim._elapsedMs); si no se pasa (llamadas
  // legacy/tests), no bloquea por cooldown.
  _canFire(nowMs) {
    if (nowMs == null) return true;
    return (nowMs - this._lastShotAt) >= CONFIG.PLAYER.SHOT_COOLDOWN_MS;
  }
  update(dt, inputX, inputY) {
    const P = CONFIG.PLAYER;
    const len = Math.hypot(inputX, inputY);
    if (len > 0.001) {
      const nx = inputX / len, ny = inputY / len;
      this.vx += nx * P.ACCEL * dt;
      this.vy += ny * P.ACCEL * dt;
      this.facingX = nx; this.facingY = ny;
      const speed = Math.hypot(this.vx, this.vy);
      if (speed > P.SPEED) { this.vx = (this.vx / speed) * P.SPEED; this.vy = (this.vy / speed) * P.SPEED; }
    } else {
      const damp = Math.max(0, 1 - P.FRICTION * dt);
      this.vx *= damp; this.vy *= damp;
      if (Math.hypot(this.vx, this.vy) < 2) { this.vx = 0; this.vy = 0; }
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const pad = 4;
    this.x = Math.max(this.radius - pad, Math.min(this.field.width - this.radius + pad, this.x));
    this.y = Math.max(this.radius - pad, Math.min(this.field.height - this.radius + pad, this.y));
  }
  distTo(obj) { return Math.hypot(this.x - obj.x, this.y - obj.y); }
  dribble(ball, dt) {
    const d = this.distTo(ball);
    const P = CONFIG.PLAYER;
    if (d < P.POSSESSION_RANGE && d > 0.01) {
      // Piso mínimo de "closeness" (pasada nueva — fix a un bug real que
      // encontró el arnés de pruebas: antes closeness caía a 0 justo al
      // borde de POSSESSION_RANGE, exactamente cuando MÁS empuje hace
      // falta para no perder el balón. Un jugador que gana posesión
      // mientras ya corre a velocidad máxima —p.ej. alcanza un balón
      // suelto a la carrera— podía "dejarlo atrás" sin ninguna
      // recuperación posible, sin llegar nunca a un tiro/pase real).
      const closeness = Math.max(0.25, 1 - Math.min(d / P.POSSESSION_RANGE, 1));
      const pushAccel = P.DRIBBLE_PUSH_ACCEL * closeness;
      ball.vx += this.facingX * pushAccel * dt;
      ball.vy += this.facingY * pushAccel * dt;
      // Blend de velocidad frame-rate-independiente (pasada nueva — antes
      // era un 5% fijo POR LLAMADA, no por segundo real: a los 30 ticks/s
      // del servidor convergía la MITAD de rápido que a los ~60fps del
      // cliente offline, una discrepancia real de "feel" online vs
      // offline. Mismo patrón dt*60 que ya usa BALL.FRICTION en
      // Ball.update() — y el nuevo 8% base también ayuda a la
      // recuperación de arriba).
      const blend = 1 - Math.pow(1 - 0.08, dt * 60);
      ball.vx += (this.vx - ball.vx) * blend;
      ball.vy += (this.vy - ball.vy) * blend;
      const maxDribbleSpeed = P.SPEED * 1.05;
      const bSpeed = Math.hypot(ball.vx, ball.vy);
      if (bSpeed > maxDribbleSpeed) { ball.vx = (ball.vx / bSpeed) * maxDribbleSpeed; ball.vy = (ball.vy / bSpeed) * maxDribbleSpeed; }
    }
  }
  canKick(ball) { return this.distTo(ball) < CONFIG.PLAYER.KICK_RANGE; }
  // Golpe de balón compartido (canKick + cooldown + kick + timestamp) —
  // usado por shoot()/pass() Y por ZoneAIController (tiro/pase de la IA),
  // para que NINGÚN golpe de balón (humano o IA) pueda saltarse el alcance
  // o el cooldown (regla 91: "misma física para todos, la IA no hace
  // trampas"). Antes de esta pasada, ZoneAIController llamaba a
  // ball.kick() directamente, sin pasar por _canFire()/SHOT_COOLDOWN_MS.
  _fireKick(ball, dirX, dirY, power, nowMs) {
    if (!this.canKick(ball)) return false;
    if (!this._canFire(nowMs)) return false;
    ball.kick(dirX, dirY, power);
    if (nowMs != null) this._lastShotAt = nowMs;
    return true;
  }
  // nowMs (opcional): reloj de MatchSim (_elapsedMs) para el cooldown
  // anti-spam (SHOT_COOLDOWN_MS). Si no se pasa, no hay cooldown (compat).
  shoot(ball, chargeRatio = 1, nowMs = null) {
    if (!this.canKick(ball)) return false;
    if (!this._canFire(nowMs)) return false;
    const P = CONFIG.PLAYER;
    const ratio = Math.max(0, Math.min(1, chargeRatio));
    const power = P.MIN_SHOT_POWER + (P.MAX_SHOT_POWER - P.MIN_SHOT_POWER) * ratio;
    ball.kick(this.facingX, this.facingY, power);
    if (nowMs != null) this._lastShotAt = nowMs;
    return true;
  }
  // Pase humano de un solo toque (sin carga, potencia fija por distancia —
  // el mismo molde que ZoneAIController._tryPass(), pero SIN las
  // imperfecciones deliberadas de la IA (PASS_SKIP_CHANCE,
  // PASS_SUBOPTIMAL_CHANCE, PASS_AIM_ERROR_RAD): es una acción del jugador,
  // no una simulación de falibilidad. Elige al mejor compañero disponible
  // con pickPassTarget() y, si existe, lo patea con la misma fórmula de
  // potencia-por-distancia que ya usa la IA. Si no hay compañero válido
  // (p.ej. 1v1), es un no-op — sin tiro de respaldo.
  pass(ball, side, ownTeam, oppTeam, nowMs = null) {
    if (!this.canKick(ball)) return false;
    if (!this._canFire(nowMs)) return false;
    const target = pickPassTarget(this, side, ownTeam, oppTeam);
    if (!target) return false;
    const A = CONFIG.AI;
    const leadX = target.x + target.vx * 0.15;
    const leadY = target.y + target.vy * 0.15;
    let dx = leadX - ball.x, dy = leadY - ball.y;
    const dlen = Math.hypot(dx, dy) || 1;
    this.facingX = dx / dlen; this.facingY = dy / dlen;
    const passDist = Math.hypot(leadX - this.x, leadY - this.y);
    const powerRatio = Math.min(1, passDist / A.PASS_POWER_DIST_REF);
    const power = A.PASS_POWER_MIN + (A.PASS_POWER_MAX - A.PASS_POWER_MIN) * powerRatio;
    ball.kick(dx, dy, power);
    if (nowMs != null) this._lastShotAt = nowMs;
    return true;
  }
}
 
// ============================================================
// pickPassCandidates / pickPassTarget — selección del "mejor compañero
// disponible" para un pase, extraída de ZoneAIController._tryPass() para
// que la reusen TANTO la IA (que además le suma sus imperfecciones
// deliberadas: PASS_SKIP_CHANCE, PASS_SUBOPTIMAL_CHANCE, PASS_AIM_ERROR_RAD)
// COMO el pase humano de un solo toque (que la usa "limpia", sin esas
// imperfecciones, porque es una acción deliberada del jugador). Puramente
// determinística: mismos filtros que antes (distancia PASS_MIN/MAX_DIST,
// "avanzando" respecto al lado que ataca, no muy marcado
// PASS_MARK_TOO_TIGHT), ordenada por qué tan libre está el compañero
// (openness = distancia al rival más cercano).
// ============================================================
function pickPassCandidates(player, side, ownTeam, oppTeam) {
  const A = CONFIG.AI;
  const candidates = [];
  for (const mate of ownTeam) {
    if (mate === player) continue;
    const d = player.distTo(mate);
    if (d < A.PASS_MIN_DIST || d > A.PASS_MAX_DIST) continue;
 
    const advancing = side === 'home' ? (mate.x >= player.x - 40) : (mate.x <= player.x + 40);
    if (!advancing) continue;
 
    let nearestOppDist = Infinity;
    for (const opp of oppTeam) {
      const od = mate.distTo(opp);
      if (od < nearestOppDist) nearestOppDist = od;
    }
    if (nearestOppDist < A.PASS_MARK_TOO_TIGHT) continue;
 
    candidates.push({ mate, openness: nearestOppDist });
  }
  candidates.sort((a, b) => b.openness - a.openness);
  return candidates;
}
 
function pickPassTarget(player, side, ownTeam, oppTeam) {
  const candidates = pickPassCandidates(player, side, ownTeam, oppTeam);
  return candidates.length ? candidates[0].mate : null;
}
 
// Traduce una potencia "objetivo" al estilo de la IA (AI.SHOT_POWER *
// variance, un número aislado sin relación con MIN/MAX_SHOT_POWER) a un
// chargeRatio 0..1 dentro del MISMO rango de potencia que un disparo
// humano (Player.shoot()), para que el gap #2 del audit (la IA se salta
// shoot()/el cooldown) se pueda arreglar simplemente llamando a
// player.shoot(ball, ratio, nowMs) — sin inventar un segundo camino de
// física. El "sabor" de potencia de la IA (que dispare algo más fuerte o
// más flojo según variance/0.85) se conserva porque el ratio resultante
// varía igual que variaba la potencia directa de antes.
function aiPowerToChargeRatio(targetPower) {
  const P = CONFIG.PLAYER;
  const span = P.MAX_SHOT_POWER - P.MIN_SHOT_POWER;
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, (targetPower - P.MIN_SHOT_POWER) / span));
}
 
// ============================================================
// ZoneAIController — puerto fiel de ArenaZoneAIController del cliente
// (mantener zona de formación, avance/repliegue, y pase imperfecto a un
// compañero — regla 29). Solo se usa para llenar slots SIN humano al
// arrancar la partida (regla 25: sin caso especial de portero, misma
// clase para cualquier slot; regla 91: mismo ball.kick() que cualquier
// disparo/pase humano, ninguna ventaja física).
// ============================================================
class ZoneAIController {
  constructor(player, field, side, zoneX, zoneY) {
    this.player = player;
    this.field = field;
    this.side = side; // 'home' (ataca hacia x = field.width) | 'away' (ataca hacia x = 0)
    this.zoneX = zoneX;
    this.zoneY = zoneY;
    this._steerX = 0;
    this._steerY = 0;
    this._passCooldown = Math.random() * (CONFIG.AI.PASS_DECISION_MAX_MS / 1000);
  }
 
  _closestOwnToBall(ball, ownTeam) {
    let best = null, bestDist = Infinity;
    for (const pl of ownTeam) {
      const d = pl.distTo(ball);
      if (d < bestDist) { bestDist = d; best = pl; }
    }
    return best;
  }
 
  _tryPass(ball, ownTeam, oppTeam, nowMs) {
    const p = this.player;
    const A = CONFIG.AI;
 
    if (p.distTo(ball) >= A.KICK_RANGE) return false;
 
    const candidates = pickPassCandidates(p, this.side, ownTeam, oppTeam);
 
    if (candidates.length === 0) return false;
    if (Math.random() < A.PASS_SKIP_CHANCE) return false;
 
    // Ya vienen ordenados por openness (más libre primero) desde
    // pickPassCandidates().
    let choice = candidates[0];
    if (candidates.length > 1 && Math.random() < A.PASS_SUBOPTIMAL_CHANCE) {
      choice = candidates[1 + Math.floor(Math.random() * (candidates.length - 1))];
    }
 
    const mate = choice.mate;
    const leadX = mate.x + mate.vx * 0.15;
    const leadY = mate.y + mate.vy * 0.15;
    let dx = leadX - ball.x, dy = leadY - ball.y;
    let dlen = Math.hypot(dx, dy) || 1;
 
    const errAngle = (Math.random() * 2 - 1) * A.PASS_AIM_ERROR_RAD;
    const cos = Math.cos(errAngle), sin = Math.sin(errAngle);
    const kx = dx * cos - dy * sin;
    const ky = dx * sin + dy * cos;
 
    p.facingX = dx / dlen; p.facingY = dy / dlen;
 
    const passDist = Math.hypot(leadX - p.x, leadY - p.y);
    const powerRatio = Math.min(1, passDist / A.PASS_POWER_DIST_REF);
    const power = A.PASS_POWER_MIN + (A.PASS_POWER_MAX - A.PASS_POWER_MIN) * powerRatio;
 
    // _fireKick() (no ball.kick() directo): mismo gate de alcance/cooldown
    // que cualquier otro golpe de balón (gap #2 del audit — antes la IA
    // podía pasar sin respetar SHOT_COOLDOWN_MS).
    return p._fireKick(ball, kx, ky, power, nowMs);
  }
 
  computeInput(ball, ownTeam, oppTeam, dt, nowMs) {
    const p = this.player;
    const A = CONFIG.AI;
    const F = this.field;
    const attackGoalX = this.side === 'home' ? F.width : 0;
    const goalY = F.goalTop + F.goalWidth / 2;
 
    let desired;
 
    if (ball.ownerPlayer === p) {
      const distToGoal = Math.hypot(p.x - attackGoalX, p.y - goalY);
      const inShootRange = distToGoal < A.KICK_RANGE + 60;
      const pastShootLimit = this.side === 'home'
        ? p.x > (F.width - A.SHOOT_X_LIMIT - 40)
        : p.x < (A.SHOOT_X_LIMIT + 40);
 
      let passed = false;
      if (!(inShootRange && pastShootLimit)) {
        this._passCooldown -= (dt || 0.016);
        if (this._passCooldown <= 0) {
          this._passCooldown = (A.PASS_DECISION_MIN_MS + Math.random() * (A.PASS_DECISION_MAX_MS - A.PASS_DECISION_MIN_MS)) / 1000;
          passed = this._tryPass(ball, ownTeam, oppTeam, nowMs);
        }
      }
 
      if (passed) {
        desired = { x: 0, y: 0 };
      } else if (inShootRange && pastShootLimit) {
        let sx = attackGoalX - ball.x, sy = goalY - ball.y;
        const slen = Math.hypot(sx, sy) || 1;
        p.facingX = sx / slen; p.facingY = sy / slen;
        if (p.distTo(ball) < A.KICK_RANGE) {
          // Gap #2 del audit: antes esto era ball.kick() directo, saltándose
          // Player.shoot() por completo (sin cooldown, potencia propia en vez
          // de la fórmula MIN/MAX_SHOT_POWER humana). Ahora pasa por el MISMO
          // shoot()/_canFire() que un disparo humano — se traduce la potencia
          // objetivo de la IA (SHOT_POWER * variance) a un chargeRatio
          // equivalente dentro del rango humano, así el "sabor" de potencia
          // de la IA se mantiene pero ya no puede saltarse el cooldown.
          const variance = 1 + (Math.random() * 2 - 1) * A.SHOT_POWER_VARIANCE;
          p.shoot(ball, aiPowerToChargeRatio(A.SHOT_POWER * variance), nowMs);
        }
        desired = { x: 0, y: 0 };
      } else {
        const dx = attackGoalX - p.x, dy = goalY - p.y;
        const len = Math.hypot(dx, dy) || 1;
        desired = { x: dx / len, y: dy / len };
      }
    } else if (!ball.owner && this._closestOwnToBall(ball, ownTeam) === p && p.distTo(ball) < A.CHASE_REACTION_DIST) {
      const leadX = ball.x + ball.vx * 0.12, leadY = ball.y + ball.vy * 0.12;
      let dx = leadX - p.x, dy = leadY - p.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist < A.KICK_RANGE) {
        let sx = attackGoalX - ball.x, sy = goalY - ball.y;
        const slen = Math.hypot(sx, sy) || 1;
        p.facingX = sx / slen; p.facingY = sy / slen;
        const variance = 1 + (Math.random() * 2 - 1) * A.SHOT_POWER_VARIANCE;
        p.shoot(ball, aiPowerToChargeRatio(A.SHOT_POWER * variance * 0.85), nowMs);
        desired = { x: 0, y: 0 };
      } else {
        desired = { x: dx / dist, y: dy / dist };
      }
    } else {
      let bias = 0;
      if (ball.owner === this.side) bias = 0.5;
      else if (ball.owner && ball.owner !== this.side) bias = -0.5;
      const attackDir = this.side === 'home' ? 1 : -1;
 
      let targetX = this.zoneX + attackDir * bias * A.ZONE_SHIFT_MAX;
      let targetY = this.zoneY;
      targetX = Math.max(p.radius, Math.min(F.width - p.radius, targetX));
 
      const faceDx = ball.x - p.x, faceDy = ball.y - p.y;
      const faceLen = Math.hypot(faceDx, faceDy) || 1;
      p.facingX = faceDx / faceLen; p.facingY = faceDy / faceLen;
 
      const dx = targetX - p.x, dy = targetY - p.y;
      const dist = Math.hypot(dx, dy);
      desired = dist < 6 ? { x: 0, y: 0 } : { x: dx / dist, y: dy / dist };
    }
 
    const smooth = 1 - Math.exp(-A.STEER_SMOOTHING * (dt || 0.016));
    this._steerX += (desired.x - this._steerX) * smooth;
    this._steerY += (desired.y - this._steerY) * smooth;
    return { inputX: this._steerX, inputY: this._steerY };
  }
}
 
function playerSnapshot(p) {
  return { x: p.x, y: p.y, facingX: p.facingX, facingY: p.facingY, chargeRatio: p.chargeRatio, number: p.number };
}
 
// ============================================================
// MatchSim — orquesta un partido completo (homeSquad + awaySquad +
// balón). '1v1' se construye exactamente igual que siempre (un solo
// jugador por lado, en los mismos puntos 0.25/0.75). '4v4'/'7v7'
// construyen homeSquad/awaySquad a partir de ARENA_FORMATIONS, igual
// que ArenaGame.setupLocalMatch() del cliente. Slots sin humano al
// arrancar (start()) quedan controlados por ZoneAIController (bots).
// inputHome/inputAway (o setInput(team,slot,vector)): { x, y,
// shootPressed } — nunca posiciones.
// ============================================================
class MatchSim {
  // customPositions (pasada nueva — editor de formación): array opcional de
  // { x, y } fraccionales (0..1), ya VALIDADO por el llamador (index.js —
  // longitud correcta para el formato, x/y numéricos finitos). Cuando viene
  // presente y su longitud coincide con la del formato, se usa EN LUGAR del
  // lookup por nombre en ARENA_FORMATIONS para decidir dónde se paran los
  // slots sin humano (bots) — así la formación "Personalizada" es real en la
  // partida en línea (autoritativa acá, en el servidor), no solo un valor
  // visual en el cliente. formationKey pasa a ser 'personalizada' en ese
  // caso, como etiqueta estable para el resto del código/broadcasts. Si
  // customPositions no es válido o no aplica, el comportamiento es
  // EXACTAMENTE el de siempre (lookup por nombre, o el primer preset si el
  // nombre no existe).
  constructor(format, formationKey, customPositions) {
    this.format = (format === '4v4' || format === '7v7') ? format : '1v1';
    this.formationKey = null;
    this.customPositions = null;
 
    if (this.format === '1v1') {
      this.field = new Field();
      const home = new Player(this.field, this.field.width * 0.25, this.field.height / 2);
      const away = new Player(this.field, this.field.width * 0.75, this.field.height / 2);
      home.zoneX = home.x; home.zoneY = home.y;
      away.zoneX = away.x; away.zoneY = away.y;
      this.homeSquad = [home];
      this.awaySquad = [away];
    } else {
      const formations = ARENA_FORMATIONS[this.format];
      const expectedLen = Object.values(formations)[0].length;
      const validCustom = Array.isArray(customPositions) &&
        customPositions.length === expectedLen &&
        customPositions.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
 
      let slots, key;
      if (validCustom) {
        // Clamp defensivo (redundante con la validación de index.js, pero
        // MatchSim no debe confiar ciegamente en el llamador): nunca deja un
        // disco fuera del 0..1 aunque algo raro llegara hasta acá.
        slots = customPositions.map(p => ({ x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) }));
        key = 'personalizada';
        this.customPositions = slots;
      } else {
        key = (formationKey && formations[formationKey]) ? formationKey : Object.keys(formations)[0];
        slots = formations[key];
      }
      this.formationKey = key;
      this.field = new Field(ARENA_FORMAT_FIELD_SIZES[this.format]);
      const field = this.field;
      this.homeSquad = slots.map((slot, i) => {
        const x = slot.x * field.width, y = slot.y * field.height;
        const p = new Player(field, x, y);
        p.number = i + 1; p.zoneX = x; p.zoneY = y;
        return p;
      });
      this.awaySquad = slots.map((slot, i) => {
        const x = (1 - slot.x) * field.width, y = slot.y * field.height;
        const p = new Player(field, x, y);
        p.number = i + 1; p.zoneX = x; p.zoneY = y;
        return p;
      });
    }
 
    this.ball = new Ball(this.field);
 
    this._homeBots = new Set();
    this._awayBots = new Set();
    this._homeControllers = new Map();
    this._awayControllers = new Map();
 
    this._homeInputs = this.homeSquad.map(() => ({ x: 0, y: 0, shootPressed: false, passPressed: false }));
    this._awayInputs = this.awaySquad.map(() => ({ x: 0, y: 0, shootPressed: false, passPressed: false }));
    this._homeCharging = this.homeSquad.map(() => false);
    this._homeChargeStart = this.homeSquad.map(() => 0);
    this._awayCharging = this.awaySquad.map(() => false);
    this._awayChargeStart = this.awaySquad.map(() => 0);
    // Borde de subida de passPressed (evita repetir el pase en cada tick
    // mientras el botón/tecla se mantenga apretado — el pase es "un solo
    // toque", no un botón mantenido como el disparo).
    this._homePassPrev = this.homeSquad.map(() => false);
    this._awayPassPrev = this.awaySquad.map(() => false);
 
    this.scoreHome = 0;
    this.scoreAway = 0;
    this.timeLeft = CONFIG.MATCH.DURATION_SECONDS;
    this.running = false;
    this.ended = false;
    this._goalFreeze = 0;
    this._lastScorer = null;
    this._elapsedMs = 0; // reloj propio del servidor (nunca Date.now())
  }
 
  // Marca qué slots (índice dentro de homeSquad/awaySquad) están sin
  // humano al arrancar y por tanto los controla la IA de zona. Llamar
  // antes de start(). El resto de slots esperan input real vía setInput().
  setBotSlots(homeBotSlots, awayBotSlots) {
    this._homeBots = new Set(homeBotSlots || []);
    this._awayBots = new Set(awayBotSlots || []);
    this._homeControllers = new Map();
    this._awayControllers = new Map();
    this.homeSquad.forEach((p, i) => {
      if (this._homeBots.has(i)) this._homeControllers.set(i, new ZoneAIController(p, this.field, 'home', p.zoneX, p.zoneY));
    });
    this.awaySquad.forEach((p, i) => {
      if (this._awayBots.has(i)) this._awayControllers.set(i, new ZoneAIController(p, this.field, 'away', p.zoneX, p.zoneY));
    });
  }
 
  // ¿Ese (team, slot) está controlado por un bot en este momento?
  isBotSlot(team, slot) {
    const bots = team === 'home' ? this._homeBots : this._awayBots;
    return bots.has(slot);
  }
 
  // Convierte un slot HUMANO a bot EN CALIENTE, a mitad de partido (regla 71:
  // desconexión -> toma de control por IA). A diferencia de setBotSlots()
  // (que se llama una sola vez antes de start() y arma TODO el mapa de bots
  // de una), esto afecta un único slot sin tocar el resto del partido en
  // curso: el jugador sigue exactamente donde estaba, el balón sigue donde
  // estaba, nadie se teletransporta. No-op si ese slot ya es bot (evita
  // pisar el ZoneAIController — y su estado interno de cooldown de pase —
  // de un slot que ya se había convertido antes).
  convertToBot(team, slot) {
    const bots = team === 'home' ? this._homeBots : this._awayBots;
    const controllers = team === 'home' ? this._homeControllers : this._awayControllers;
    const squad = team === 'home' ? this.homeSquad : this.awaySquad;
    if (bots.has(slot)) return false;
    const p = squad[slot];
    if (!p) return false;
    bots.add(slot);
    controllers.set(slot, new ZoneAIController(p, this.field, team, p.zoneX, p.zoneY));
    // Deja de "cargar" un disparo que el humano pudiera tener a medio
    // apretar en el instante de desconectarse (si no, chargeRatio quedaría
    // congelado para siempre, ya que _updateShootCharge() ya no se llama
    // para un slot bot).
    const chargingArr = team === 'home' ? this._homeCharging : this._awayCharging;
    if (chargingArr) chargingArr[slot] = false;
    p.chargeRatio = 0;
    return true;
  }
 
  // Inverso de convertToBot(): reclama un slot BOT de vuelta para un humano
  // que se reconecta (regla de "reconectar al mismo puesto"). Quita ese slot
  // del set de bots, borra su ZoneAIController (para que deje de moverlo) y
  // resetea su entrada de input a neutro (para no arrastrar un input viejo
  // que ya no corresponde a nadie). Igual que convertToBot(), NUNCA toca
  // posición/velocidad: el jugador sigue exactamente donde el bot lo dejó,
  // nadie se teletransporta. No-op (devuelve false) si ese slot no era bot.
  convertToHuman(team, slot) {
    const bots = team === 'home' ? this._homeBots : this._awayBots;
    const controllers = team === 'home' ? this._homeControllers : this._awayControllers;
    const inputs = team === 'home' ? this._homeInputs : this._awayInputs;
    const passPrev = team === 'home' ? this._homePassPrev : this._awayPassPrev;
    if (!bots.has(slot)) return false;
    bots.delete(slot);
    controllers.delete(slot);
    if (inputs[slot]) inputs[slot] = { x: 0, y: 0, shootPressed: false, passPressed: false };
    if (passPrev) passPrev[slot] = false;
    return true;
  }
 
  // Input de un slot HUMANO. Se ignora si ese slot está controlado por bot.
  setInput(team, slot, vector) {
    const bots = team === 'home' ? this._homeBots : this._awayBots;
    if (bots.has(slot)) return;
    const arr = team === 'home' ? this._homeInputs : this._awayInputs;
    if (arr[slot]) arr[slot] = vector || { x: 0, y: 0, shootPressed: false, passPressed: false };
  }
 
  resetPositions() {
    this.ball.reset();
    this.homeSquad.forEach((p, i) => {
      p.x = p.zoneX; p.y = p.zoneY; p.vx = 0; p.vy = 0; p.chargeRatio = 0;
      this._homeCharging[i] = false;
    });
    this.awaySquad.forEach((p, i) => {
      p.x = p.zoneX; p.y = p.zoneY; p.vx = 0; p.vy = 0; p.chargeRatio = 0;
      this._awayCharging[i] = false;
    });
  }
 
  start() {
    this.scoreHome = 0; this.scoreAway = 0;
    this.timeLeft = CONFIG.MATCH.DURATION_SECONDS;
    this.running = true; this.ended = false;
    this.resetPositions();
  }
 
  // dt en segundos. Cada slot humano usa el input guardado por setInput();
  // cada slot bot usa su ZoneAIController. Nunca se leen posiciones del cliente.
  tick(dt) {
    if (!this.running || this.ended) return { goal: null, ended: false };
    this._elapsedMs += dt * 1000;
 
    if (this._goalFreeze > 0) {
      this._goalFreeze -= dt;
      return { goal: null, ended: false };
    }
 
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.running = false;
      this.ended = true;
      return { goal: null, ended: true };
    }
 
    this._stepSquad('home', this.homeSquad, this._homeBots, this._homeControllers, this.awaySquad, dt);
    this._stepSquad('away', this.awaySquad, this._awayBots, this._awayControllers, this.homeSquad, dt);
 
    this._updatePossession(dt);
    this.ball.update(dt);
 
    const all = this.homeSquad.concat(this.awaySquad);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) this._resolvePlayerCollision(all[i], all[j]);
    }
 
    const scorer = this.field.checkGoal(this.ball);
    if (scorer) {
      this._handleGoal(scorer);
      return { goal: scorer, ended: false };
    }
    return { goal: null, ended: false };
  }
 
  _stepSquad(side, squad, bots, controllers, oppSquad, dt) {
    const inputs = side === 'home' ? this._homeInputs : this._awayInputs;
    const passPrev = side === 'home' ? this._homePassPrev : this._awayPassPrev;
    squad.forEach((p, i) => {
      if (bots.has(i)) {
        const ctrl = controllers.get(i);
        const r = ctrl.computeInput(this.ball, squad, oppSquad, dt, this._elapsedMs);
        p.update(dt, r.inputX, r.inputY);
      } else {
        const inp = inputs[i] || { x: 0, y: 0, shootPressed: false, passPressed: false };
        p.update(dt, inp.x, inp.y);
        this._updateShootCharge(p, inp.shootPressed, side, i);
        // Pase humano: acción de un solo toque, disparada en el flanco de
        // subida de passPressed (no en cada tick mientras se mantiene
        // apretado) — sin carga, potencia fija por distancia. canKick() y
        // el cooldown (_lastShotAt) los valida Player.pass() mismo. Si no
        // hay compañero válido (1v1, o nadie libre), es un no-op.
        const isPassPressed = !!inp.passPressed;
        if (isPassPressed && !passPrev[i]) {
          p.pass(this.ball, side, squad, oppSquad, this._elapsedMs);
        }
        passPrev[i] = isPassPressed;
      }
    });
  }
 
  _updateShootCharge(player, pressed, side, slot) {
    const P = CONFIG.PLAYER;
    const chargingArr = side === 'home' ? this._homeCharging : this._awayCharging;
    const startArr = side === 'home' ? this._homeChargeStart : this._awayChargeStart;
    if (pressed) {
      if (!chargingArr[slot]) {
        chargingArr[slot] = true;
        startArr[slot] = this._elapsedMs;
      }
      const held = this._elapsedMs - startArr[slot];
      player.chargeRatio = Math.min(held / P.CHARGE_MS, 1);
    } else if (chargingArr[slot]) {
      chargingArr[slot] = false;
      const ratio = player.chargeRatio;
      player.shoot(this.ball, ratio, this._elapsedMs);
      player.chargeRatio = 0;
    }
  }
 
  // Generalización de la posesión/tackle a N jugadores por lado (busca el
  // más cercano en vez de comparar exactamente dos distancias). Para 1v1
  // (squads de un jugador cada uno) esto reduce exactamente a la misma
  // fórmula/resultado que la versión original de dos jugadores.
  _updatePossession(dt) {
    const P = CONFIG.PLAYER;
    const ball = this.ball;
    const home = this.homeSquad, away = this.awaySquad;
 
    if (!ball.owner) {
      let best = null, bestDist = Infinity, bestSide = null;
      for (const p of home) {
        const d = p.distTo(ball);
        if (d < P.POSSESSION_RANGE && d < bestDist) { bestDist = d; best = p; bestSide = 'home'; }
      }
      for (const p of away) {
        const d = p.distTo(ball);
        if (d < P.POSSESSION_RANGE && d < bestDist) { bestDist = d; best = p; bestSide = 'away'; }
      }
      if (best) { ball.owner = bestSide; ball.ownerPlayer = best; }
    } else {
      const ownerDist = ball.ownerPlayer ? ball.ownerPlayer.distTo(ball) : Infinity;
      if (ownerDist > P.POSSESSION_RANGE * 1.3) {
        ball.owner = null; ball.ownerPlayer = null;
      } else {
        const opponents = ball.owner === 'home' ? away : home;
        let nearestOpp = null, nearestDist = Infinity;
        for (const p of opponents) {
          const d = p.distTo(ball);
          if (d < nearestDist) { nearestDist = d; nearestOpp = p; }
        }
        if (nearestOpp && nearestDist < P.TACKLE_RANGE) {
          if (Math.random() < P.TACKLE_CHANCE_PER_SEC * dt) {
            const dx = ball.x - nearestOpp.x, dy = ball.y - nearestOpp.y;
            ball.kick(dx, dy, P.TACKLE_IMPULSE);
            ball.owner = ball.owner === 'home' ? 'away' : 'home';
            ball.ownerPlayer = nearestOpp;
          }
        }
      }
    }
 
    if (ball.ownerPlayer) ball.ownerPlayer.dribble(ball, dt);
  }
 
  // Separación posicional (anti-solape, de siempre) + impulso de velocidad
  // a lo largo de la normal de colisión (pasada nueva — "el mayor gap vs.
  // HaxBall" del audit: antes era un empuje puramente geométrico, cero
  // cambio de velocidad, así que dos jugadores que chocaban de frente no
  // "rebotaban" en absoluto). Modesto y acotado a propósito (arcade, no
  // bumper cars): solo se intercambia la componente de velocidad relativa
  // A LO LARGO de la normal (aproximación de choque elástico simple, sin
  // masas distintas — todos los jugadores tienen el mismo RADIUS/mismo
  // "peso"), escalada por COLLISION_BOUNCE y con un tope de magnitud
  // (COLLISION_IMPULSE_MAX) para que nunca sea explosivo.
  _resolvePlayerCollision(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 0.01;
    const minDist = a.radius + b.radius;
    if (dist < minDist) {
      const overlap = (minDist - dist) / 2;
      const nx = dx / dist, ny = dy / dist;
      a.x -= nx * overlap; a.y -= ny * overlap;
      b.x += nx * overlap; b.y += ny * overlap;
 
      const P = CONFIG.PLAYER;
      // Velocidad relativa a lo largo de la normal (positivo = se están
      // acercando uno al otro sobre la normal a->b).
      const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
      const relN = rvx * nx + rvy * ny;
      if (relN < 0) {
        // Impulso de choque elástico simple (masas iguales): cada uno
        // recibe la mitad del cambio, escalado por el coeficiente de rebote
        // y acotado para que el choque nunca sea explosivo/inestable.
        let j = -(1 + P.COLLISION_BOUNCE) * relN / 2;
        j = Math.min(j, P.COLLISION_IMPULSE_MAX);
        a.vx -= j * nx; a.vy -= j * ny;
        b.vx += j * nx; b.vy += j * ny;
      }
    }
  }
 
  _handleGoal(scorer) {
    if (scorer === 'home') this.scoreHome++; else this.scoreAway++;
    this._lastScorer = scorer;
    this._goalFreeze = 1.6;
    this.resetPositions();
  }
 
  // Snapshot mínimo para transmitir a los clientes (ellos solo renderizan).
  // 1v1: MISMA forma de siempre (state.home/state.away objetos sueltos) —
  // no se toca el contrato ya probado con el cliente. 4v4/7v7: arrays
  // homeSquad/awaySquad con un objeto por jugador (incluye `number` para
  // el dorsal).
  getSnapshot() {
    const base = {
      ball: { x: this.ball.x, y: this.ball.y, owner: this.ball.owner },
      scoreHome: this.scoreHome,
      scoreAway: this.scoreAway,
      timeLeft: this.timeLeft,
    };
    if (this.format === '1v1') {
      base.home = playerSnapshot(this.homeSquad[0]);
      base.away = playerSnapshot(this.awaySquad[0]);
    } else {
      base.format = this.format;
      base.homeSquad = this.homeSquad.map(playerSnapshot);
      base.awaySquad = this.awaySquad.map(playerSnapshot);
    }
    return base;
  }
}
 
module.exports = { CONFIG, ARENA_FORMATIONS, ARENA_FORMAT_FIELD_SIZES, Field, Ball, Player, ZoneAIController, MatchSim };
 
