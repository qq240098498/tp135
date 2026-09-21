// 对外动作集合：页面只经过这一层，球队、场地、赛程与积分表各自管好自己的校验
const { ApiError, pickText } = require('./errors');
const { load } = require('./store');
const teams = require('./teams');
const venues = require('./venues');
const matches = require('./matches');
const { buildPots, drawGroups, readGroupSize: drawReadGroupSize } = require('./draw');
const { computeTable } = require('./standings');

function readQuery(query, name) {
  return pickText(query && query[name]);
}

// 概览用的一块数据：几个数字、最近打完的几场、积分榜前三
function summary() {
  const data = load();
  const table = computeTable({}).table;
  const played = data.matches.filter((item) => item.status === '已赛');
  const recent = played
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1) || (a.kickoff < b.kickoff ? 1 : -1))
    .slice(0, 5)
    .map((item) => {
      const home = data.teams.find((t) => t.id === item.homeTeamId);
      const away = data.teams.find((t) => t.id === item.awayTeamId);
      return {
        id: item.id,
        round: item.round,
        date: item.date,
        homeName: home ? home.name : '未知球队',
        awayName: away ? away.name : '未知球队',
        scoreText: `${item.homeGoals} : ${item.awayGoals}`,
      };
    });

  return {
    season: data.meta.season,
    points: data.meta.points,
    teamCount: data.teams.length,
    activeTeamCount: data.teams.filter((item) => item.status === '参赛').length,
    venueCount: data.venues.length,
    totalMatches: data.matches.length,
    playedMatches: played.length,
    pendingMatches: data.matches.filter((item) => item.status === '待赛').length,
    postponedMatches: data.matches.filter((item) => item.status === '延期').length,
    playedRounds: new Set(played.map((item) => item.round)).size,
    totalRounds: Math.max(...data.matches.map((item) => item.round), 0),
    topThree: table.slice(0, 3),
    recent,
  };
}

// 抽签用的参赛球队：只取状态为参赛的，按上赛季名次排好
function activeTeamsForDraw() {
  const data = load();
  return data.teams
    .filter((item) => item.status === '参赛')
    .slice()
    .sort((a, b) => a.seedRank - b.seedRank);
}

// 抽签前先看档位：按名次会切成哪几档、哪些队落在最后一个不满档
function previewPots(options) {
  const input = options && typeof options === 'object' ? options : {};
  const active = activeTeamsForDraw();
  if (active.length < 2) {
    throw new ApiError(400, 'DRAW_TEAMS_TOO_FEW', '参赛球队不足 2 支，先到球队页登记再抽签', '');
  }
  const groupSize = drawReadGroupSize(input, active.length);
  const built = buildPots(active, groupSize);
  return {
    groupSize: built.groupSize,
    groupCount: built.groupCount,
    potCount: built.potCount,
    teamCount: active.length,
    placedCount: built.placedCount,
    pots: built.pots,
    remainder: built.remainder,
  };
}

// 执行抽签：纯函数算出结果，不落库；种子编号随结果返回，填回即可复现
function performDraw(payload) {
  const active = activeTeamsForDraw();
  return drawGroups(active, payload || {});
}

module.exports = {
  ApiError,
  readQuery,
  summary,
  computeTable,
  previewPots,
  performDraw,
  ...teams,
  ...venues,
  ...matches,
};
