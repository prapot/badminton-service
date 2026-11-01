// Pure ranking math (no Strapi access) — used by services/ranking.ts and covered by rankingMath.test.ts

export const BRAVE_POINTS_CAP = 100;
export const RP_PER_STAR = 100;
// Upset bonus for winners (beating a team whose avg weight is higher): floor(diff / 20), capped
export const UPSET_MIN_WEIGHT_DIFF = 200;
export const MAX_UPSET_BONUS = 30;
// Consolation bonus for losers who lost to a much stronger team
export const UNDERDOG_LOSS_WEIGHT_DIFF = 500;
export const UNDERDOG_LOSS_BONUS = 10;

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
