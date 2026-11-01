import { describe, it, expect } from 'vitest';
import { computeLoserUpdate, computeRevert, computeWinnerUpdate, currentRankInfo, describeRankResult, getRankInfoFromPoints, MAX_UPSET_BONUS, nextRankInfo } from './rankingMath';

const win = (o: Partial<Parameters<typeof computeWinnerUpdate>[0]> = {}) =>
    computeWinnerUpdate({ oldRp: 500, oldBp: 0, streakBefore: 0, tier: 'Silver', weightDiff: 0, isRankingMode: true, ...o });
const lose = (o: Partial<Parameters<typeof computeLoserUpdate>[0]> = {}) =>
    computeLoserUpdate({ oldRp: 500, oldBp: 0, tier: 'Silver', weightDiff: 0, isRankingMode: true, ...o });

describe('computeWinnerUpdate', () => {
    it('gives +1 star and 30 BP for a plain win', () => {
        expect(win()).toEqual({ newRp: 600, newBp: 30, rpChange: 100, bpChange: 30 });
    });

    it('gives a bonus star when BP fills, keeping the remainder', () => {
        expect(win({ oldBp: 80 })).toEqual({ newRp: 700, newBp: 10, rpChange: 200, bpChange: -70 });
    });

    it('reaches the bonus star on the 3rd straight win from 0 BP', () => {
        let bp = 0, streak = 0, rp = 0;
        const gains: number[] = [];
        for (let i = 0; i < 3; i++) {
            const r = win({ oldRp: rp, oldBp: bp, streakBefore: streak });
            gains.push(r.rpChange);
            rp = r.newRp; bp = r.newBp; streak++;
        }
        expect(gains).toEqual([100, 100, 200]);
    });

    it('Master: +1 star only, no BP or bonus star', () => {
        expect(win({ tier: 'Master', oldRp: 5000, oldBp: 80, streakBefore: 4 })).toEqual({ newRp: 5100, newBp: 80, rpChange: 100, bpChange: 0 });
    });

    it('still gives the bonus on the win that promotes into Master', () => {
        expect(win({ tier: 'Diamond', oldRp: 4400, oldBp: 90 }).newRp).toBe(4600);
    });

    it('caps the upset bonus', () => {
        expect(win({ weightDiff: 5000 }).newBp).toBe(30 + MAX_UPSET_BONUS);
        expect(win({ weightDiff: 200 }).newBp).toBe(30); // threshold is exclusive
    });

    it('changes nothing outside ranking mode', () => {
        expect(win({ isRankingMode: false })).toEqual({ newRp: 500, newBp: 0, rpChange: 0, bpChange: 0 });
    });
});

describe('computeLoserUpdate', () => {
    it('loses a star and gains 15 BP', () => {
        expect(lose()).toEqual({ newRp: 400, newBp: 15, rpChange: -100, bpChange: 15 });
    });

    it('uses full BP to protect the star', () => {
        expect(lose({ oldBp: 90 })).toEqual({ newRp: 500, newBp: 5, rpChange: 0, bpChange: -85 });
    });

    it('never loses stars in Bronze and caps BP instead of overflowing', () => {
        expect(lose({ tier: 'Bronze', oldRp: 200, oldBp: 95 })).toEqual({ newRp: 200, newBp: 100, rpChange: 0, bpChange: 5 });
    });

    it('adds the underdog consolation bonus', () => {
        expect(lose({ weightDiff: -600 }).newBp).toBe(25);
    });

    it('Master: always loses a star, BP never protects', () => {
        expect(lose({ tier: 'Master', oldRp: 5100, oldBp: 100 })).toEqual({ newRp: 5000, newBp: 100, rpChange: -100, bpChange: 0 });
    });

    it('never goes below 0 RP', () => {
        expect(lose({ oldRp: 50 }).newRp).toBe(0);
    });
});

describe('computeRevert', () => {
    it('round-trips a win (RP, BP, streak, points)', () => {
        const before = { ranking_points: 500, brave_points: 80, win_streak: 2, match_played: 5, win: 3, lose: 2, point_for: 60, point_against: 50 };
        const d = win({ oldRp: 500, oldBp: 80, streakBefore: 2 });
        const after = { ranking_points: d.newRp, brave_points: d.newBp, win_streak: 3, match_played: 6, win: 4, lose: 2, point_for: 81, point_against: 65 };
        const history = { rp_change: d.rpChange, bp_change: d.bpChange, win_streak_before: 2, is_win: true, point_for: 21, point_against: 15 };
        expect(computeRevert({ ranking: after, history, isLatest: true })).toEqual(before);
    });

    it('round-trips a protected loss and restores the streak when latest', () => {
        const before = { ranking_points: 500, brave_points: 90, win_streak: 4, match_played: 5, win: 4, lose: 1, point_for: 0, point_against: 0 };
        const d = lose({ oldRp: 500, oldBp: 90 });
        const after = { ...before, ranking_points: d.newRp, brave_points: d.newBp, win_streak: 0, match_played: 6, lose: 2 };
        const history = { rp_change: d.rpChange, bp_change: d.bpChange, win_streak_before: 4, is_win: false };
        expect(computeRevert({ ranking: after, history, isLatest: true })).toEqual(before);
    });

    it('keeps the current streak when reverting an older loss', () => {
        const r = computeRevert({ ranking: { win_streak: 2 }, history: { is_win: false, win_streak_before: 5 }, isLatest: false });
        expect(r.win_streak).toBe(2);
    });

    it('handles legacy history rows without bp_change / streak', () => {
        const r = computeRevert({ ranking: { ranking_points: 300, brave_points: 40, win_streak: 0, lose: 1 }, history: { rp_change: -100, is_win: false }, isLatest: true });
        expect(r).toMatchObject({ ranking_points: 400, brave_points: 40, win_streak: 0, lose: 0 });
    });
});

describe('rank at a division boundary (900 RP = Bronze I 3★ or Silver III 0★)', () => {
    const bronzeTop = { rank: 'Bronze I', stars: 3, rank_tier: 'Bronze' };
    const silverBottom = { rank: 'Silver III', stars: 0, rank_tier: 'Silver' };

    it('reads the stored rank when it matches the RP', () => {
        expect(currentRankInfo(bronzeTop, 900).rankStr).toBe('Bronze I');
        expect(currentRankInfo(silverBottom, 900)).toMatchObject({ tier: 'Silver', rankStr: 'Silver III', stars: 0 });
    });

    it('ignores a stored rank that does not fit the RP', () => {
        expect(currentRankInfo({ rank: 'Master', rank_tier: 'Master' }, 900).rankStr).toBe('Bronze I');
        expect(currentRankInfo({}, 900).rankStr).toBe('Bronze I');
    });

    it('Bronze I 3★ losing stays Bronze I 3★ (used to flip to Silver III 0★)', () => {
        const tier = currentRankInfo(bronzeTop, 900).tier;
        const d = lose({ oldRp: 900, tier });
        expect(d.rpChange).toBe(0);
        expect(nextRankInfo(bronzeTop, 900, d.newRp, true)).toMatchObject({ rankStr: 'Bronze I', stars: 3 });
    });

    it('Silver III 0★ losing drops to Bronze I 2★ (used to be protected forever)', () => {
        const tier = currentRankInfo(silverBottom, 900).tier;
        const d = lose({ oldRp: 900, tier });
        expect(d.newRp).toBe(800);
        expect(nextRankInfo(silverBottom, 900, d.newRp, true)).toMatchObject({ rankStr: 'Bronze I', stars: 2 });
    });

    it('Silver III 0★ keeps its rank when RP does not move (protected loss / casual match)', () => {
        expect(nextRankInfo(silverBottom, 900, 900, false).rankStr).toBe('Silver III');
        expect(nextRankInfo(silverBottom, 900, 900, true).rankStr).toBe('Silver III');
    });

    it('wins from either state land on Silver III 1★', () => {
        expect(nextRankInfo(bronzeTop, 900, 1000, false)).toMatchObject({ rankStr: 'Silver III', stars: 1 });
        expect(nextRankInfo(silverBottom, 900, 1000, false)).toMatchObject({ rankStr: 'Silver III', stars: 1 });
    });

    it('Master starts at 4500 RP', () => {
        expect(getRankInfoFromPoints(4500).tier).toBe('Master');
        expect(getRankInfoFromPoints(4400, { isLoss: true })).toMatchObject({ rankStr: 'Diamond I', stars: 2 });
    });
});

describe('describeRankResult', () => {
    const info = (rp: number, isLoss = false) => getRankInfoFromPoints(rp, { isLoss });
    const describe_ = (isWin: boolean, delta: ReturnType<typeof computeWinnerUpdate>, oldBp: number, oldRp: number) =>
        describeRankResult({ matchId: 7, isWin, delta, oldBp, before: info(oldRp), after: info(delta.newRp, !isWin) });

    it('plain win', () => {
        const d = win({ oldRp: 400, oldBp: 0 });
        expect(describe_(true, d, 0, 400)).toMatchObject({ starChange: 1, bonusStar: false, bpGain: 30, bp: 30, movement: null, rankAfter: 'Bronze II', starsAfter: 2 });
    });

    it('bonus star win that ranks up', () => {
        const d = win({ oldRp: 800, oldBp: 80 });
        expect(describe_(true, d, 80, 800)).toMatchObject({ starChange: 2, bonusStar: true, bpGain: 30, bp: 10, rankBefore: 'Bronze I', rankAfter: 'Silver III', movement: 'up' });
    });

    it('shielded loss', () => {
        const d = lose({ oldRp: 1500, oldBp: 90 });
        expect(describe_(false, d, 90, 1500)).toMatchObject({ starChange: 0, shielded: true, bronzeSafe: false, bpGain: 15, bp: 5 });
    });

    it('Bronze loss', () => {
        const d = lose({ tier: 'Bronze', oldRp: 200, oldBp: 0 });
        expect(describe_(false, d, 0, 200)).toMatchObject({ starChange: 0, shielded: false, bronzeSafe: true, bpGain: 15 });
    });

    it('loss that drops a division (Silver III 0★ → Bronze I 2★)', () => {
        const d = lose({ oldRp: 900, oldBp: 0 });
        const r = describeRankResult({ matchId: 7, isWin: false, delta: d, oldBp: 0, before: info(900, true), after: info(d.newRp, true) });
        expect(r).toMatchObject({ starChange: -1, movement: 'down', rankBefore: 'Silver III', rankAfter: 'Bronze I', starsAfter: 2 });
    });

    it('Master has no brave points', () => {
        const d = win({ tier: 'Master', oldRp: 5000, oldBp: 40 });
        expect(describe_(true, d, 40, 5000)).toMatchObject({ starChange: 1, bonusStar: false, bp: null, bpGain: 0, starsAfter: 6 });
    });
});
