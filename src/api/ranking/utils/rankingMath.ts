// Pure ranking math (no Strapi access) — used by services/ranking.ts and covered by rankingMath.test.ts

export const BRAVE_POINTS_CAP = 100;
export const RP_PER_STAR = 100;
// Upset bonus for winners (beating a team whose avg weight is higher): floor(diff / 20), capped
export const UPSET_MIN_WEIGHT_DIFF = 200;
export const MAX_UPSET_BONUS = 30;
// Consolation bonus for losers who lost to a much stronger team
export const UNDERDOG_LOSS_WEIGHT_DIFF = 500;
export const UNDERDOG_LOSS_BONUS = 10;

export interface RankInfo {
    tier: string;
    division: string;
    divisionNum: number;
    stars: number;
    rankStr: string;
    weight: number;
}

// RoV-style 3-star ranking logic (full 3 stars -> rank up to 1 star; 1 star -> 0 stars; 0 stars -> demote to 2 stars)
export function getRankInfoFromPoints(points: number, options?: { isLoss?: boolean }): RankInfo {
    const isLoss = options?.isLoss === true;
    const TIERS = [
        { name: 'Bronze', divisions: 3 },
        { name: 'Silver', divisions: 3 },
        { name: 'Gold', divisions: 3 },
        { name: 'Platinum', divisions: 3 },
        { name: 'Diamond', divisions: 3 },
        { name: 'Master', divisions: 1 }
    ];
    const DIVS = ['V', 'IV', 'III', 'II', 'I'];
    let p = Math.max(0, points);

    const pointsPerDiv = 300;
    const standardTiers = TIERS.filter(t => t.name !== 'Master');
    const totalDivisions = standardTiers.reduce((acc, t) => acc + t.divisions, 0); // 15
    const masterThreshold = totalDivisions * pointsPerDiv; // 4500

    if (p >= masterThreshold) {
        const masterPoints = p - masterThreshold;
        const stars = Math.floor(masterPoints / 100);
        return {
            tier: 'Master',
            division: '',
            divisionNum: 1,
            stars: stars,
            rankStr: 'Master',
            weight: 6000 + (stars * 10)
        };
    }

    let divIdx = Math.floor(p / pointsPerDiv);
    let rem = p % pointsPerDiv;
    let stars = Math.floor(rem / 100);

    // Division boundary handling (e.g. 300, 600, 900 RP):
    // - On normal/win/rank-up: represents full 3 stars of the previous division
    // - On loss (or at 0 stars of current division): represents 0 stars of the current division
    if (rem === 0 && divIdx > 0) {
        if (!isLoss) {
            divIdx = divIdx - 1;
            stars = 3;
        } else {
            stars = 0;
        }
    }

    let runningDivs = 0;
    for (let i = 0; i < standardTiers.length; i++) {
        const t = standardTiers[i];
        if (divIdx < runningDivs + t.divisions) {
            const localDivIdx = divIdx - runningDivs;
            const activeDivs = DIVS.slice(5 - t.divisions);
            const divisionStr = activeDivs[localDivIdx];
            return {
                tier: t.name,
                division: divisionStr,
                divisionNum: t.divisions - localDivIdx,
                stars: stars,
                rankStr: `${t.name} ${divisionStr}`,
                weight: 1000 + (i * 1000) + (localDivIdx * 250) + (stars * 50)
            };
        }
        runningDivs += t.divisions;
    }

    return { tier: 'Bronze', division: 'III', divisionNum: 3, stars: 0, rankStr: 'Bronze III', weight: 1000 };
}

/** Rank fields as stored on a ranking row */
export interface StoredRank {
    rank?: string | null;
    stars?: number | null;
    rank_tier?: string | null;
    rank_division?: number | null;
}

/**
 * RP ตรงขอบ division (เช่น 900) แทนได้ 2 สถานะ: "Bronze I 3 ดาว" หรือ "Silver III 0 ดาว"
 * ขึ้นกับผลแมตช์ล่าสุด → ใช้แรงค์ที่บันทึกไว้ (ที่ผู้เล่นเห็น) ถ้ายังสอดคล้องกับ RP
 */
export function currentRankInfo(stored: StoredRank, rp: number): RankInfo {
    const asWin = getRankInfoFromPoints(rp, { isLoss: false });
    const asLoss = getRankInfoFromPoints(rp, { isLoss: true });
    if (stored.rank === asLoss.rankStr && stored.rank !== asWin.rankStr) return asLoss;
    return asWin;
}

/** Rank to show after a match: unchanged RP keeps the current rank (no flip across a division boundary) */
export function nextRankInfo(stored: StoredRank, oldRp: number, newRp: number, isLoss: boolean): RankInfo {
    if (newRp === oldRp) return currentRankInfo(stored, oldRp);
    return getRankInfoFromPoints(newRp, { isLoss });
}

export function calculateBravePoints(isWin: boolean, currentStreak: number = 0): number {
    if (!isWin) return 15; // แพ้ได้แต้มปลอบใจ 15 BP
    let bp = 30; // ชนะปกติ 30 BP
    // โบนัสชนะติดกัน (สไตล์ ROV): 2 นัด 40, 3 นัด 50, 4 นัด 60, 5+ นัด 70
    if (currentStreak >= 5) bp += 40;
    else if (currentStreak >= 4) bp += 30;
    else if (currentStreak >= 3) bp += 20;
    else if (currentStreak >= 2) bp += 10;
    return bp;
}

export interface RankingDelta {
    newRp: number;
    newBp: number;
    rpChange: number;
    bpChange: number;
}

/**
 * weightDiff = avg weight of losers − avg weight of winners
 * (> 0 means the winners beat a stronger team)
 */
export function computeWinnerUpdate(p: {
    oldRp: number;
    oldBp: number;
    streakBefore: number;
    /** tier before this match (Master has no brave points) */
    tier: string;
    weightDiff: number;
    isRankingMode: boolean;
}): RankingDelta {
    if (!p.isRankingMode) return { newRp: p.oldRp, newBp: p.oldBp, rpChange: 0, bpChange: 0 };
    // Master: ชนะ +1 ดาว ไม่มีแต้มกล้าหาญ/ดาวโบนัส (BP คงค่าเดิมไว้จนกว่าจะตกจาก Master)
    if (p.tier === 'Master') {
        return { newRp: p.oldRp + RP_PER_STAR, newBp: p.oldBp, rpChange: RP_PER_STAR, bpChange: 0 };
    }

    let bpGain = calculateBravePoints(true, p.streakBefore + 1);
    if (p.weightDiff > UPSET_MIN_WEIGHT_DIFF) {
        bpGain += Math.min(MAX_UPSET_BONUS, Math.floor(p.weightDiff / 20));
    }

    let newBp = p.oldBp + bpGain;
    let rpChange = RP_PER_STAR;
    if (newBp >= BRAVE_POINTS_CAP) {
        rpChange += RP_PER_STAR; // ดาวโบนัส +1
        newBp -= BRAVE_POINTS_CAP;
    }
    // ไม่ให้ BP ค้างเกินหลอด (ป้องกันได้ดาวโบนัสติดกันจากแต้มล้น)
    newBp = Math.min(newBp, BRAVE_POINTS_CAP);

    return { newRp: p.oldRp + rpChange, newBp, rpChange, bpChange: newBp - p.oldBp };
}

export function computeLoserUpdate(p: {
    oldRp: number;
    oldBp: number;
    tier: string;
    weightDiff: number;
    isRankingMode: boolean;
}): RankingDelta {
    if (!p.isRankingMode) return { newRp: p.oldRp, newBp: p.oldBp, rpChange: 0, bpChange: 0 };
    // Master: แพ้ −1 ดาวเสมอ ไม่มีการกันดาวด้วย BP
    if (p.tier === 'Master') {
        const newRp = Math.max(0, p.oldRp - RP_PER_STAR);
        return { newRp, newBp: p.oldBp, rpChange: newRp - p.oldRp, bpChange: 0 };
    }

    let bpGain = calculateBravePoints(false);
    if (p.weightDiff < -UNDERDOG_LOSS_WEIGHT_DIFF) bpGain += UNDERDOG_LOSS_BONUS;

    let newBp = p.oldBp + bpGain;
    let rpLoss = 0;
    if (p.tier !== 'Bronze') {
        rpLoss = RP_PER_STAR;
        // ใช้แต้มกล้าหาญเต็มหลอดกันดาวลด
        if (newBp >= BRAVE_POINTS_CAP) {
            rpLoss = 0;
            newBp -= BRAVE_POINTS_CAP;
        }
    }
    // Bronze ไม่ใช้ BP กันดาว → ตันไว้ที่หลอดเต็ม (เดิมสะสมล้นได้ไม่จำกัด)
    newBp = Math.min(newBp, BRAVE_POINTS_CAP);

    const newRp = Math.max(0, p.oldRp - rpLoss);
    return { newRp, newBp, rpChange: newRp - p.oldRp, bpChange: newBp - p.oldBp };
}

export interface RevertInput {
    ranking: {
        ranking_points?: number | null;
        brave_points?: number | null;
        win_streak?: number | null;
        match_played?: number | null;
        win?: number | null;
        lose?: number | null;
        point_for?: number | null;
        point_against?: number | null;
    };
    history: {
        rp_change?: number | null;
        bp_change?: number | null;
        win_streak_before?: number | null;
        is_win?: boolean | null;
        point_for?: number | null;
        point_against?: number | null;
    };
    /** true when no newer match-history exists for this ranking */
    isLatest: boolean;
}

/** Undo one match-history record. Returns the ranking fields to write (rank/stars are derived by the caller). */
export function computeRevert({ ranking: r, history: h, isLatest }: RevertInput) {
    const n = (v: number | null | undefined) => Number(v || 0);
    const isWin = h.is_win === true;

    let winStreak = n(r.win_streak);
    if (isWin) {
        winStreak = Math.max(0, winStreak - 1);
    } else if (isLatest && h.win_streak_before != null) {
        // แพ้รีเซ็ต streak เป็น 0 → คืนค่าเดิมได้เฉพาะเมื่อเป็นแมตช์ล่าสุด
        winStreak = n(h.win_streak_before);
    }

    return {
        ranking_points: Math.max(0, n(r.ranking_points) - n(h.rp_change)),
        brave_points: Math.min(BRAVE_POINTS_CAP, Math.max(0, n(r.brave_points) - n(h.bp_change))),
        win_streak: winStreak,
        match_played: Math.max(0, n(r.match_played) - 1),
        win: isWin ? Math.max(0, n(r.win) - 1) : n(r.win),
        lose: !isWin ? Math.max(0, n(r.lose) - 1) : n(r.lose),
        point_for: Math.max(0, n(r.point_for) - n(h.point_for)),
        point_against: Math.max(0, n(r.point_against) - n(h.point_against)),
    };
}

/** Payload of the `user-<id>` `rank-result` event (mirrored in the frontend's RankResult type) */
export interface RankResult {
    matchId: number;
    isWin: boolean;
    rpChange: number;
    /** stars gained (+) or lost (−) this match */
    starChange: number;
    bonusStar: boolean;
    /** lost but full brave points saved the star */
    shielded: boolean;
    /** lost in Bronze (no star loss) */
    bronzeSafe: boolean;
    bpGain: number;
    /** null for Master (no brave points) */
    bp: number | null;
    rankBefore: string;
    rankAfter: string;
    starsAfter: number;
    /** division moved up / down */
    movement: 'up' | 'down' | null;
}

export function describeRankResult(p: {
    matchId: number;
    isWin: boolean;
    delta: RankingDelta;
    oldBp: number;
    before: RankInfo;
    after: RankInfo;
}): RankResult {
    const { delta, before, after, isWin } = p;
    const isMaster = before.tier === 'Master' || after.tier === 'Master';
    const starChange = Math.round(delta.rpChange / RP_PER_STAR);
    const lossWithoutStarLoss = !isWin && delta.rpChange === 0;
    // BP ที่ได้จากแมตช์นี้ (ก่อนหักใช้ดาวโบนัส/กันดาว)
    const spent = (isWin && starChange > 1) || (lossWithoutStarLoss && before.tier !== 'Bronze') ? BRAVE_POINTS_CAP : 0;
    let movement: RankResult['movement'] = null;
    if (before.rankStr !== after.rankStr) movement = after.weight > before.weight ? 'up' : 'down';

    return {
        matchId: p.matchId,
        isWin,
        rpChange: delta.rpChange,
        starChange,
        bonusStar: isWin && starChange > 1,
        shielded: lossWithoutStarLoss && before.tier !== 'Bronze' && !isMaster,
        bronzeSafe: lossWithoutStarLoss && before.tier === 'Bronze',
        bpGain: isMaster ? 0 : delta.newBp - p.oldBp + spent,
        bp: isMaster && after.tier === 'Master' ? null : delta.newBp,
        rankBefore: before.rankStr,
        rankAfter: after.rankStr,
        starsAfter: after.stars,
        movement,
    };
}
