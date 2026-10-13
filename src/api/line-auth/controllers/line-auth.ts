/**
 * LINE Login — a LINE account is linked to an existing Strapi user, either from the profile
 * page (already signed in) or right after a LINE sign-in that found no linked user: login
 * then returns a short-lived link ticket, and the user signs in / registers through the
 * normal /auth/local endpoints and redeems the ticket with their new JWT.
 */

import crypto from 'crypto';
import { isLineUserIdConflict } from '../../../utils/lineUserIdIndex';
import { createTtlStore } from '../ttl-store';

const USER_UID = 'plugin::users-permissions.user';

interface LineProfile {
  lineUserId: string;
  displayName: string;
}

/** LINE accounts have no email (we don't request it) — users set a real one in their profile */
const PLACEHOLDER_EMAIL_DOMAIN = 'line.invalid';

async function getAuthUser(ctx: any) {
  const authHeader = ctx.request.header.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const payload = await (strapi as any).plugin('users-permissions').service('jwt').verify(authHeader.substring(7));
    if (!payload?.id) return null;
    const user = await strapi.db.query(USER_UID).findOne({ where: { id: payload.id } });
    // a blocked user's JWT may still be unexpired — treat it as signed out
    return user && !user.blocked ? user : null;
  } catch {
    return null;
  }
}

const LINK_TICKET_TTL_SECONDS = 10 * 60;

function signTicket(body: string): string {
  return crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET || '').update(body).digest('base64url');
}

/** Signed with the channel secret (not JWT_SECRET) so it can never pass as a Strapi auth token */
function issueLinkTicket(profile: LineProfile): string {
  const body = Buffer.from(JSON.stringify({
    ...profile,
    exp: Math.floor(Date.now() / 1000) + LINK_TICKET_TTL_SECONDS,
  })).toString('base64url');
  return `${body}.${signTicket(body)}`;
}

function readLinkTicket(ticket: unknown): LineProfile | null {
  if (typeof ticket !== 'string' || !process.env.LINE_CHANNEL_SECRET) return null;
  const [body, sig] = ticket.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(signTicket(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const { lineUserId, displayName, exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!lineUserId || exp < Date.now() / 1000) return null;
    return { lineUserId, displayName: displayName || '' };
  } catch {
    return null;
  }
}

const LINE_TAKEN_MESSAGE = 'บัญชี LINE นี้เชื่อมต่อกับผู้ใช้อื่นอยู่แล้ว';

/** Link a verified LINE account to user; returns an error message instead of throwing */
async function attachLine(user: any, profile: LineProfile): Promise<string | null> {
  const owner = await strapi.db.query(USER_UID).findOne({ where: { line_user_id: profile.lineUserId } });
  if (owner && owner.id !== user.id) {
    return LINE_TAKEN_MESSAGE;
  }
  try {
    await strapi.db.query(USER_UID).update({
      where: { id: user.id },
      data: { line_user_id: profile.lineUserId, line_display_name: profile.displayName },
    });
  } catch (e) {
    if (isLineUserIdConflict(e)) return LINE_TAKEN_MESSAGE;
    throw e;
  }
  return null;
}

/** LINE display name as username (min 3 chars, unique) — adds a random suffix when taken */
async function pickUsername(displayName: string): Promise<string> {
  let base = displayName.trim().replace(/\s+/g, ' ').slice(0, 30);
  if (base.length < 3) base = base ? `${base}_line` : 'line_user';
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = attempt === 0 ? base : `${base}_${crypto.randomInt(1000, 10000)}`;
    const taken = await strapi.db.query(USER_UID).count({ where: { username: candidate } });
    if (!taken) return candidate;
  }
  return `${base}_${crypto.randomUUID().slice(0, 8)}`;
}

interface CodeGrant {
  code: string;
  redirectUri: string;
  nonce: string;
  codeVerifier: string;
}

function lineChannel() {
  const channelId = process.env.LINE_CHANNEL_ID;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!channelId || !channelSecret) {
    throw new Error('LINE Login ยังไม่ได้ตั้งค่าบนเซิร์ฟเวอร์');
  }
  return { channelId, channelSecret };
}

/** Legacy flow (frontend kept state/nonce/PKCE in the browser) — remove once every client uses /start */
async function fetchLineProfile(body: any): Promise<LineProfile> {
  const { code, redirectUri, nonce, codeVerifier } = body || {};
  if (!code || !redirectUri || !nonce || !codeVerifier) {
    throw new Error('ข้อมูลจาก LINE ไม่ครบ');
  }
  return exchangeCode({ code, redirectUri, nonce, codeVerifier });
}

/** Exchange the authorization code (with the PKCE verifier) and verify the ID token (incl. nonce) with LINE */
async function exchangeCode({ code, redirectUri, nonce, codeVerifier }: CodeGrant): Promise<LineProfile> {
  const { channelId, channelSecret } = lineChannel();

  const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: channelId,
      client_secret: channelSecret,
      code_verifier: codeVerifier,
    }),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as any;
  if (!tokenRes.ok || !token.id_token) {
    console.warn('[LINE] token exchange failed:', token.error, token.error_description);
    throw new Error('ยืนยันตัวตนกับ LINE ไม่สำเร็จ กรุณาลองใหม่');
  }

  const verifyRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: token.id_token, client_id: channelId, nonce }),
  });
  const claims = (await verifyRes.json().catch(() => ({}))) as any;
  if (!verifyRes.ok || !claims.sub) {
    console.warn('[LINE] id_token verify failed:', claims.error, claims.error_description);
    throw new Error('ยืนยันตัวตนกับ LINE ไม่สำเร็จ กรุณาลองใหม่');
  }

  return { lineUserId: claims.sub, displayName: claims.name || '' };
}


/*
 * Server-side sign-in state. On phones the LINE app finishes the sign-in and opens the
 * callback itself — on iOS in its own browser, which shares no storage with the Safari tab
 * that started — so state/nonce/PKCE live here, keyed by the `state` sent to LINE.
 * For login, the starting tab also gets a handoff id: when the sign-in completes elsewhere,
 * that tab can claim the session from GET /line-auth/handoff/:id when the user returns.
 */
const SIGN_IN_TTL_MS = 10 * 60 * 1000;

interface PendingSignIn extends Omit<CodeGrant, 'code'> {
  mode: 'login' | 'link';
  redirect: string;
  /** link: the signed-in user who started it (from their JWT) */
  linkUserId?: number;
  /** login: where the finished session is parked for the starting tab */
  handoffId?: string;
}

const pendingSignIns = createTtlStore<PendingSignIn>(SIGN_IN_TTL_MS);
/** handoffId → JWT once the sign-in finished; `null` while still waiting */
const handoffs = createTtlStore<string | null>(SIGN_IN_TTL_MS);

const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

/** Same rules as the frontend's safeRedirectPath: on-site paths only */
function safeRedirectPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return fallback;
  return /[\\\u0000-\u001f\u007f]/.test(value) ? fallback : value;
}

const CALLBACK_PATH = '/auth/line/callback';

function issueJwt(userId: number): string {
  return (strapi as any).plugin('users-permissions').service('jwt').issue({ id: userId });
}

const SIGN_IN_EXPIRED_MESSAGE = 'การเข้าสู่ระบบด้วย LINE หมดอายุแล้ว กรุณากดเข้าสู่ระบบด้วย LINE ใหม่อีกครั้ง';

export default {
  /** Begin a LINE sign-in: returns the LINE authorize URL (and a handoff id for login) */
  async start(ctx) {
    const { mode, redirect, redirectUri } = ctx.request.body || {};
    if (mode !== 'login' && mode !== 'link') return ctx.badRequest('mode ไม่ถูกต้อง');
    let callbackUrl: URL;
    try {
      callbackUrl = new URL(redirectUri);
    } catch {
      return ctx.badRequest('redirectUri ไม่ถูกต้อง');
    }
    // LINE also rejects any callback not registered in the console
    if (!/^https?:$/.test(callbackUrl.protocol) || callbackUrl.pathname !== CALLBACK_PATH || callbackUrl.search) {
      return ctx.badRequest('redirectUri ไม่ถูกต้อง');
    }

    let channelId: string;
    try {
      ({ channelId } = lineChannel());
    } catch (e) {
      return ctx.internalServerError(e.message);
    }

    let linkUserId: number | undefined;
    if (mode === 'link') {
      const user = await getAuthUser(ctx);
      if (!user) return ctx.unauthorized('กรุณาเข้าสู่ระบบก่อน');
      linkUserId = user.id;
    }

    const state = randomId();
    const codeVerifier = randomId(32);
    const pending: PendingSignIn = {
      mode,
      redirect: safeRedirectPath(redirect),
      redirectUri: callbackUrl.toString(),
      nonce: randomId(),
      codeVerifier,
      linkUserId,
      handoffId: mode === 'login' ? randomId() : undefined,
    };
    pendingSignIns.set(state, pending);
    if (pending.handoffId) handoffs.set(pending.handoffId, null);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: channelId,
      redirect_uri: pending.redirectUri,
      state,
      nonce: pending.nonce,
      code_challenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'profile openid',
    });
    return ctx.send({
      authorizeUrl: `https://access.line.me/oauth2/v2.1/authorize?${params}`,
      handoffId: pending.handoffId ?? null,
    });
  },

  /** LINE redirected back (in whatever browser): finish with only `code` + `state` */
  async callback(ctx) {
    const { code, state } = ctx.request.body || {};
    const pending = typeof state === 'string' ? pendingSignIns.take(state) : undefined;
    if (!pending || typeof code !== 'string' || !code) {
      return ctx.badRequest(SIGN_IN_EXPIRED_MESSAGE);
    }

    let profile: LineProfile;
    try {
      profile = await exchangeCode({ ...pending, code });
    } catch (e) {
      return ctx.badRequest(e.message);
    }

    if (pending.mode === 'link') {
      const user = await strapi.db.query(USER_UID).findOne({ where: { id: pending.linkUserId } });
      if (!user || user.blocked) return ctx.unauthorized('กรุณาเข้าสู่ระบบก่อน');
      const error = await attachLine(user, profile);
      if (error) return ctx.badRequest(error);
      return ctx.send({ result: 'linked', displayName: profile.displayName, redirect: pending.redirect });
    }

    const user = await strapi.db.query(USER_UID).findOne({ where: { line_user_id: profile.lineUserId } });
    if (!user) {
      return ctx.send({
        result: 'not_linked',
        linkTicket: issueLinkTicket(profile),
        displayName: profile.displayName,
        redirect: pending.redirect,
        // lets the account chosen/created on the callback page reach the starting tab too
        handoffId: pending.handoffId,
      });
    }
    if (user.blocked) return ctx.forbidden('บัญชีนี้ถูกระงับการใช้งาน');

    const jwt = issueJwt(user.id);
    handoffs.set(pending.handoffId!, jwt);
    return ctx.send({ result: 'login', jwt, redirect: pending.redirect });
  },

  /** After linking/registering on the callback page: park that session for the starting tab */
  async publishHandoff(ctx) {
    const user = await getAuthUser(ctx);
    if (!user) return ctx.unauthorized('กรุณาเข้าสู่ระบบก่อน');
    const { handoffId } = ctx.request.body || {};
    // only a sign-in still waiting (null) can be filled, and only once
    if (typeof handoffId !== 'string' || handoffs.get(handoffId) !== null) {
      return ctx.badRequest(SIGN_IN_EXPIRED_MESSAGE);
    }
    handoffs.set(handoffId, issueJwt(user.id));
    return ctx.send({ ok: true });
  },

  /** The starting tab asks whether its LINE sign-in finished elsewhere; the session is handed over once */
  async claimHandoff(ctx) {
    const { id } = ctx.params;
    const jwt = handoffs.get(id);
    if (jwt === undefined) return ctx.notFound(SIGN_IN_EXPIRED_MESSAGE);
    if (jwt === null) return ctx.send({ status: 'pending' });
    handoffs.take(id);
    return ctx.send({ status: 'done', jwt });
  },

  async login(ctx) {
    let profile: LineProfile;
    try {
      profile = await fetchLineProfile(ctx.request.body);
    } catch (e) {
      return ctx.badRequest(e.message);
    }

    const user = await strapi.db.query(USER_UID).findOne({ where: { line_user_id: profile.lineUserId } });
    if (!user) {
      return ctx.notFound('บัญชี LINE นี้ยังไม่ได้เชื่อมต่อกับบัญชีใด', {
        code: 'LINE_NOT_LINKED',
        linkTicket: issueLinkTicket(profile),
        displayName: profile.displayName,
      });
    }
    if (user.blocked) {
      return ctx.forbidden('บัญชีนี้ถูกระงับการใช้งาน');
    }

    const jwt = (strapi as any).plugin('users-permissions').service('jwt').issue({ id: user.id });
    return ctx.send({ jwt });
  },

  async status(ctx) {
    const user = await getAuthUser(ctx);
    if (!user) return ctx.unauthorized('กรุณาเข้าสู่ระบบก่อน');
    return ctx.send({
      linked: !!user.line_user_id,
      displayName: user.line_display_name || null,
    });
  },

  async link(ctx) {
    const user = await getAuthUser(ctx);
    if (!user) return ctx.unauthorized('กรุณาเข้าสู่ระบบก่อน');

    let profile: LineProfile;
    try {
      profile = await fetchLineProfile(ctx.request.body);
    } catch (e) {
      return ctx.badRequest(e.message);
    }

    const error = await attachLine(user, profile);
    if (error) return ctx.badRequest(error);
    return ctx.send({ linked: true, displayName: profile.displayName });
  },

  /** Redeem the ticket from an unlinked LINE sign-in, after signing in / registering normally */
  async linkTicket(ctx) {
    const user = await getAuthUser(ctx);
    if (!user) return ctx.unauthorized('กรุณาเข้าสู่ระบบก่อน');

    const profile = readLinkTicket(ctx.request.body?.linkTicket);
    if (!profile) {
      return ctx.badRequest('การยืนยันตัวตนกับ LINE หมดอายุแล้ว กรุณาเข้าสู่ระบบด้วย LINE ใหม่อีกครั้ง');
    }

    const error = await attachLine(user, profile);
    if (error) return ctx.badRequest(error);
    return ctx.send({ linked: true, displayName: profile.displayName });
  },

  /**
   * Create a new account from an unlinked LINE sign-in: username = LINE name, a placeholder
   * email and a random password — the user can set a real email / password in their profile.
   */
  async register(ctx) {
    const profile = readLinkTicket(ctx.request.body?.linkTicket);
    if (!profile) {
      return ctx.badRequest('การยืนยันตัวตนกับ LINE หมดอายุแล้ว กรุณาเข้าสู่ระบบด้วย LINE ใหม่อีกครั้ง');
    }

    const settings: any = await strapi.store({ type: 'plugin', name: 'users-permissions', key: 'advanced' }).get();
    if (!settings?.allow_register) {
      return ctx.forbidden('ระบบปิดการสมัครสมาชิกอยู่');
    }

    if (await strapi.db.query(USER_UID).findOne({ where: { line_user_id: profile.lineUserId } })) {
      return ctx.badRequest(LINE_TAKEN_MESSAGE);
    }

    const role = await strapi.db.query('plugin::users-permissions.role').findOne({
      where: { type: settings.default_role },
    });
    if (!role) return ctx.internalServerError('Impossible to find the default role');

    let user;
    try {
      user = await (strapi as any).plugin('users-permissions').service('user').add({
        username: await pickUsername(profile.displayName),
        email: `${profile.lineUserId.toLowerCase()}@${PLACEHOLDER_EMAIL_DOMAIN}`,
        password: crypto.randomBytes(24).toString('base64url'),
        provider: 'local',
        confirmed: true,
        role: role.id,
        line_user_id: profile.lineUserId,
        line_display_name: profile.displayName,
      });
    } catch (e) {
      // double-click / two tabs: the other request already created the account
      if (isLineUserIdConflict(e)) return ctx.badRequest(LINE_TAKEN_MESSAGE);
      throw e;
    }

    const jwt = (strapi as any).plugin('users-permissions').service('jwt').issue({ id: user.id });
    return ctx.send({ jwt });
  },

  async unlink(ctx) {
    const user = await getAuthUser(ctx);
    if (!user) return ctx.unauthorized('กรุณาเข้าสู่ระบบก่อน');

    await strapi.db.query(USER_UID).update({
      where: { id: user.id },
      data: { line_user_id: null, line_display_name: null },
    });
    return ctx.send({ linked: false, displayName: null });
  },
};
