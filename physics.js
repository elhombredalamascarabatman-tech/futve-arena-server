// ============================================================
// FUTVE ARENA — motor de física puro para el servidor (sin DOM,
// sin canvas). Es un puerto fiel de la física del cliente
// (mismos valores de ARENA_CONFIG, mismas fórmulas) para que jugar
// en línea se sienta IGUAL que jugar contra la IA localmente.
// El servidor es la única autoridad: nunca confía en posiciones que
// mande un cliente, solo en su INPUT (dirección + si dispara).
// ============================================================

const CONFIG = {
  FIELD: { WIDTH: 900, HEIGHT: 560, GOAL_WIDTH: 140, GOAL_DEPTH: 22 },
  PLAYER: {
    RADIUS: 14,
    SPEED: 220,
    ACCEL: 1400,
    FRICTION: 10,
    KICK_RANGE: 26,
    MIN_SHOT_POWER: 260,
    MAX_SHOT_POWER: 640,
    CHARGE_MS: 700,
    DRIBBLE_PUSH_ACCEL: 820,
    POSSESSION_RANGE: 30,
    TACKLE_RANGE: 22,
    TACKLE_CHANCE_PER_SEC: 1.3,
    TACKLE_IMPULSE: 170,
  },
  BALL: { RADIUS: 9, FRICTION: 0.985, MIN_SPEED: 4, WALL_BOUNCE: 0.75 },
  // Duración real del partido: 120s, igual que en el cliente. Se puede
  // sobreescribir solo vía variable de entorno (usado en pruebas locales
  // para no esperar 2 minutos reales); en producción no se define y se
  // usa siempre el valor real.
  MATCH: { DURATION_SECONDS: Number(process.env.ARENA_MATCH_DURATION_SECONDS) || 120 },
};

class Field {
  constructor() {
    this.width = CONFIG.FIELD.WIDTH;
    this.height = CONFIG.FIELD.HEIGHT;
    this.goalWidth = CONFIG.FIELD.GOAL_WIDTH;
    this.goalDepth = CONFIG.FIELD.GOAL_DEPTH;
    this.goalTop = (this.height - this.goalWidth) / 2;
    this.goalBottom = this.goalTop + this.goalWidth;
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
    this.owner = null;
    this.reset();
  }
  reset() {
    this.x = this.field.width / 2;
    this.y = this.field.height / 2;
    this.vx = 0; this.vy = 0;
    this.owner = null;
  }
  kick(dirX, dirY, power) {
    const len = Math.hypot(dirX, dirY) || 1;
    this.vx = (dirX / len) * power;
    this.vy = (dirY / len) * power;
    this.owner = null;
  }
  update(dt) {
    const f = Math.pow(CONFIG.BALL.FRICTION, dt * 60);
    this.vx *= f;
    this.vy *= f;
    if (Math.hypot(this.vx, this.vy) < CONFIG.BALL.MIN_SPEED) { this.vx = 0; this.vy = 0; }

    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.handleWalls();
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
      const closeness = 1 - Math.min(d / P.POSSESSION_RANGE, 1);
      const pushAccel = P.DRIBBLE_PUSH_ACCEL * closeness;
      ball.vx += this.facingX * pushAccel * dt;
      ball.vy += this.facingY * pushAccel * dt;
      ball.vx += (this.vx - ball.vx) * 0.05;
      ball.vy += (this.vy - ball.vy) * 0.05;
      const maxDribbleSpeed = P.SPEED * 1.05;
      const bSpeed = Math.hypot(ball.vx, ball.vy);
      if (bSpeed > maxDribbleSpeed) { ball.vx = (ball.vx / bSpeed) * maxDribbleSpeed; ball.vy = (ball.vy / bSpeed) * maxDribbleSpeed; }
    }
  }
  canKick(ball) { return this.distTo(ball) < CONFIG.PLAYER.KICK_RANGE; }
  shoot(ball, chargeRatio = 1) {
    if (!this.canKick(ball)) return false;
    const P = CONFIG.PLAYER;
    const ratio = Math.max(0, Math.min(1, chargeRatio));
    const power = P.MIN_SHOT_POWER + (P.MAX_SHOT_POWER - P.MIN_SHOT_POWER) * ratio;
    ball.kick(this.facingX, this.facingY, power);
    return true;
  }
}

// ============================================================
// MatchSim — orquesta un partido completo (home + away + balón),
// puerto fiel de ArenaGame.update()/updatePossession()/handleGoal()
// del cliente, pero SIN IA, SIN render, SIN requestAnimationFrame.
// El servidor WebSocket (game.js) llama a tick(dt, inputHome, inputAway)
// en un bucle de paso fijo y transmite getSnapshot() a ambos jugadores.
// inputHome/inputAway: { x, y, shootPressed } — nunca posiciones.
// ============================================================
class MatchSim {
  constructor() {
    this.field = new Field();
    this.ball = new Ball(this.field);
    this.home = new Player(this.field, this.field.width * 0.25, this.field.height / 2);
    this.away = new Player(this.field, this.field.width * 0.75, this.field.height / 2);

    this.scoreHome = 0;
    this.scoreAway = 0;
    this.timeLeft = CONFIG.MATCH.DURATION_SECONDS;
    this.running = false;
    this.ended = false;
    this._goalFreeze = 0;
    this._lastScorer = null;

    this._homeCharging = false;
    this._homeChargeStart = 0;
    this._awayCharging = false;
    this._awayChargeStart = 0;
    this._elapsedMs = 0; // reloj propio del servidor (nunca Date.now(), ver nota abajo)
  }

  resetPositions() {
    this.ball.reset();
    this.home.x = this.field.width * 0.25; this.home.y = this.field.height / 2;
    this.home.vx = 0; this.home.vy = 0;
    this.away.x = this.field.width * 0.75; this.away.y = this.field.height / 2;
    this.away.vx = 0; this.away.vy = 0;
    this.home.chargeRatio = 0; this.away.chargeRatio = 0;
    this._homeCharging = false; this._awayCharging = false;
  }

  start() {
    this.scoreHome = 0; this.scoreAway = 0;
    this.timeLeft = CONFIG.MATCH.DURATION_SECONDS;
    this.running = true; this.ended = false;
    this.resetPositions();
  }

  // dt en segundos, inputHome/inputAway = { x, y, shootPressed } (dirección normalizada -1..1, nunca posición).
  tick(dt, inputHome, inputAway) {
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

    const ih = inputHome || { x: 0, y: 0, shootPressed: false };
    const ia = inputAway || { x: 0, y: 0, shootPressed: false };

    this.home.update(dt, ih.x, ih.y);
    this._updateShootCharge(this.home, ih.shootPressed, 'home');
    this.away.update(dt, ia.x, ia.y);
    this._updateShootCharge(this.away, ia.shootPressed, 'away');

    this._updatePossession(dt);
    this.ball.update(dt);
    this._resolvePlayerCollision(this.home, this.away);

    const scorer = this.field.checkGoal(this.ball);
    if (scorer) {
      this._handleGoal(scorer);
      return { goal: scorer, ended: false };
    }
    return { goal: null, ended: false };
  }

  _updateShootCharge(player, pressed, side) {
    const P = CONFIG.PLAYER;
    const chargingKey = side === 'home' ? '_homeCharging' : '_awayCharging';
    const startKey = side === 'home' ? '_homeChargeStart' : '_awayChargeStart';
    if (pressed) {
      if (!this[chargingKey]) {
        this[chargingKey] = true;
        this[startKey] = this._elapsedMs;
      }
      const held = this._elapsedMs - this[startKey];
      player.chargeRatio = Math.min(held / P.CHARGE_MS, 1);
    } else if (this[chargingKey]) {
      this[chargingKey] = false;
      const ratio = player.chargeRatio;
      player.shoot(this.ball, ratio);
      player.chargeRatio = 0;
    }
  }

  _updatePossession(dt) {
    const P = CONFIG.PLAYER;
    const ball = this.ball;
    const distHome = this.home.distTo(ball);
    const distAway = this.away.distTo(ball);
    const inRangeHome = distHome < P.POSSESSION_RANGE;
    const inRangeAway = distAway < P.POSSESSION_RANGE;

    if (!ball.owner) {
      if (inRangeHome && inRangeAway) ball.owner = distHome <= distAway ? 'home' : 'away';
      else if (inRangeHome) ball.owner = 'home';
      else if (inRangeAway) ball.owner = 'away';
    } else {
      const ownerDist = ball.owner === 'home' ? distHome : distAway;
      if (ownerDist > P.POSSESSION_RANGE * 1.3) {
        ball.owner = null;
      } else {
        const opponent = ball.owner === 'home' ? this.away : this.home;
        const opponentDist = ball.owner === 'home' ? distAway : distHome;
        if (opponentDist < P.TACKLE_RANGE) {
          if (Math.random() < P.TACKLE_CHANCE_PER_SEC * dt) {
            ball.owner = ball.owner === 'home' ? 'away' : 'home';
            const dx = ball.x - opponent.x, dy = ball.y - opponent.y;
            ball.kick(dx, dy, P.TACKLE_IMPULSE);
          }
        }
      }
    }

    if (ball.owner === 'home') this.home.dribble(ball, dt);
    else if (ball.owner === 'away') this.away.dribble(ball, dt);
  }

  _resolvePlayerCollision(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 0.01;
    const minDist = a.radius + b.radius;
    if (dist < minDist) {
      const overlap = (minDist - dist) / 2;
      const nx = dx / dist, ny = dy / dist;
      a.x -= nx * overlap; a.y -= ny * overlap;
      b.x += nx * overlap; b.y += ny * overlap;
    }
  }

  _handleGoal(scorer) {
    if (scorer === 'home') this.scoreHome++; else this.scoreAway++;
    this._lastScorer = scorer;
    this._goalFreeze = 1.6;
    this.resetPositions();
  }

  // Snapshot mínimo para transmitir a ambos clientes (ellos solo renderizan).
  getSnapshot() {
    return {
      home: { x: this.home.x, y: this.home.y, facingX: this.home.facingX, facingY: this.home.facingY, chargeRatio: this.home.chargeRatio },
      away: { x: this.away.x, y: this.away.y, facingX: this.away.facingX, facingY: this.away.facingY, chargeRatio: this.away.chargeRatio },
      ball: { x: this.ball.x, y: this.ball.y, owner: this.ball.owner },
      scoreHome: this.scoreHome,
      scoreAway: this.scoreAway,
      timeLeft: this.timeLeft,
    };
  }
}

module.exports = { CONFIG, Field, Ball, Player, MatchSim };
