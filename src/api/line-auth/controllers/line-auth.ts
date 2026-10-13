/**
 * LINE Login — a LINE account is linked to an existing Strapi user, either from the profile
 * page (already signed in) or right after a LINE sign-in that found no linked user: login
 * then returns a short-lived link ticket, and the user signs in / registers through the
 * normal /auth/local endpoints and redeems the ticket with their new JWT.
 */

import crypto from 'crypto';

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
    return await strapi.db.query(USER_UID).findOne({ where: { id: payload.id } });
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

/** Link a verified LINE account to user; returns an error message instead of throwing */
async function attachLine(user: any, profile: LineProfile): Promise<string | null> {
  const owner = await strapi.db.query(USER_UID).findOne({ where: { line_user_id: profile.lineUserId } });
  if (owner && owner.id !== user.id) {
    return 'บัญชี LINE นี้เชื่อมต่อกับผู้ใช้อื่นอยู่แล้ว';
  }
  await strapi.db.query(USER_UID).update({
    where: { id: user.id },
    data: { line_user_id: profile.lineUserId, line_display_name: profile.displayName },
  });
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

/** Exchange the authorization code and verify the ID token (incl. nonce) with LINE */
async function fetchLineProfile(body: any): Promise<LineProfile> {
  const channelId = process.env.LINE_CHANNEL_ID;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!channelId || !channelSecret) {
    throw new Error('LINE Login ยังไม่ได้ตั้งค่าบนเซิร์ฟเวอร์');
  }

  const { code, redirectUri, nonce } = body || {};
  if (!code || !redirectUri || !nonce) {
    throw new Error('ข้อมูลจาก LINE ไม่ครบ');
  }

  const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: channelId,
      client_secret: channelSecret,
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

export default {
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
      return ctx.badRequest('บัญชี LINE นี้เชื่อมต่อกับผู้ใช้อื่นอยู่แล้ว');
    }

    const role = await strapi.db.query('plugin::users-permissions.role').findOne({
      where: { type: settings.default_role },
    });
    if (!role) return ctx.internalServerError('Impossible to find the default role');

    const user = await (strapi as any).plugin('users-permissions').service('user').add({
      username: await pickUsername(profile.displayName),
      email: `${profile.lineUserId.toLowerCase()}@${PLACEHOLDER_EMAIL_DOMAIN}`,
      password: crypto.randomBytes(24).toString('base64url'),
      provider: 'local',
      confirmed: true,
      role: role.id,
      line_user_id: profile.lineUserId,
      line_display_name: profile.displayName,
    });

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
