// 赛季分组抽签：按上赛季名次（seedRank）把参赛球队分成若干档，再逐档抽一支落进每个组。
// 随机数全部来自种子编号推导的确定性序列，同一种子复现同一次抽签；
// 同城球队落到同一组时按回避规则改投其他组并记录重试，重试越过上限就停下说明，不做死循环。
const { load } = require('./store');
const { ApiError, pickText } = require('./errors');

const DEFAULT_MAX_RETRIES = 500;
const MIN_MAX_RETRIES = 1;
const MAX_MAX_RETRIES = 10000;
const SEED_MAX_LENGTH = 40;
// 重试次数精确计数并参与上限判断；逐条记录只保留前若干条，避免极端情况下响应体无限膨胀
const RETRY_LOG_LIMIT = 200;

// 字符串种子先做一次 xmur3 式哈希，再喂给 mulberry32；同一编号永远得到同一条随机序列
function hashSeed(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function createRng(seedText) {
  const seed = hashSeed(`tp135-draw:${seedText}`)();
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// 默认按每组四队去凑组数，凑不整就退每组三队、两队；再不行按四舍五入，余下队落不下
function resolveGroupCount(total, input) {
  const raw = input === undefined || input === null || input === '' ? null : Number(input);
  if (raw === null) {
    if (total <= 4) return 2;
    if (total % 4 === 0) return total / 4;
    if (total % 3 === 0) return total / 3;
    if (total % 2 === 0) return total / 2;
    return Math.min(total, Math.max(2, Math.round(total / 4)));
  }
  if (!Number.isInteger(raw) || raw < 2 || raw > total) {
    throw new ApiError(400, 'GROUP_COUNT_INVALID', `组数要填 2 到参赛队数（${total}）之间的整数，参赛队凑不出这么多组`, 'groupCount');
  }
  return raw;
}

function resolveMaxRetries(input) {
  const raw = input === undefined || input === null || input === '' ? DEFAULT_MAX_RETRIES : Number(input);
  if (!Number.isInteger(raw) || raw < MIN_MAX_RETRIES || raw > MAX_MAX_RETRIES) {
    throw new ApiError(400, 'MAX_RETRIES_INVALID', `重试上限要填 ${MIN_MAX_RETRIES} 到 ${MAX_MAX_RETRIES} 之间的整数`, 'maxRetries');
  }
  return raw;
}

// 参赛队按上赛季名次排好，前 K*G 支每 G 支组成一档，剩下的凑不齐一档则落不下
function buildPots(activeTeams, groupCount) {
  const ordered = activeTeams.slice().sort((a, b) => (a.seedRank - b.seedRank) || (a.id < b.id ? -1 : 1));
  const potCount = Math.floor(ordered.length / groupCount);
  const placed = ordered.slice(0, potCount * groupCount);
  const remainder = ordered.slice(potCount * groupCount);
  const pots = [];
  for (let p = 0; p < potCount; p += 1) {
    pots.push(placed.slice(p * groupCount, (p + 1) * groupCount));
  }
  return { ordered, pots, placed, remainder, potCount };
}

function cityCountsOf(teams) {
  const map = new Map();
  teams.forEach((team) => {
    if (!team.city) return;
    map.set(team.city, (map.get(team.city) || 0) + 1);
  });
  return map;
}

function teamBrief(team) {
  return {
    teamId: team.id,
    name: team.name,
    shortName: team.shortName,
    city: team.city,
    seedRank: team.seedRank,
  };
}

// 抽签前的分档预览：哪几档、每档有谁、哪些队根本不进抽签、城市分布有没有必然无解
function previewDraw(options) {
  const input = options && typeof options === 'object' ? options : {};
  const data = load();
  const active = data.teams.filter((team) => team.status === '参赛');
  const withdrawn = data.teams.filter((team) => team.status !== '参赛');
  if (active.length < 2) {
    throw new ApiError(409, 'NOT_ENOUGH_TEAMS', '参赛球队不足两支，至少要两支才能分组抽签', 'groupCount');
  }
  const groupCount = resolveGroupCount(active.length, input.groupCount);
  const maxRetries = input.maxRetries === undefined || input.maxRetries === null || input.maxRetries === ''
    ? DEFAULT_MAX_RETRIES : resolveMaxRetries(input.maxRetries);
  const { pots, remainder, potCount } = buildPots(active, groupCount);

  const leftovers = remainder.map((team) => ({
    ...teamBrief(team),
    reason: `参赛队共 ${active.length} 支、分 ${groupCount} 组时每组 ${potCount} 支，只需要 ${potCount * groupCount} 支；这是多出来的第 ${team.seedRank} 名，凑不齐完整一档，不进抽签`,
  }));

  const cityCounts = cityCountsOf(active);
  const warnings = [];
  cityCounts.forEach((count, city) => {
    if (count > groupCount) {
      warnings.push(`${city} 有 ${count} 支参赛队，但只有 ${groupCount} 个组；同城的队不能同组，这个分布无论怎么抽都避不开，建议增加组数`);
    }
  });

  return {
    season: data.meta.season,
    teamCount: data.teams.length,
    activeCount: active.length,
    groupCount,
    perGroup: potCount,
    potCount,
    placedCount: potCount * groupCount,
    maxRetries,
    pots: pots.map((pot, index) => ({
      potNo: index + 1,
      teams: pot.map(teamBrief),
    })),
    leftovers,
    withdrawnTeams: withdrawn.map((team) => ({ ...teamBrief(team), status: team.status })),
    cityCounts: Array.from(cityCounts.entries()).map(([city, count]) => ({ city, count })),
    warnings,
  };
}

// 真正抽签：逐档逐队落位，候选组随机洗牌后取第一个不撞同城的；走不通就回溯。
// 返回分组、每队落位（第几组第几档）与每一次回避重试的记录。
function runDraw(activeTeams, options) {
  const { seedText, groupCount, maxRetries } = options;
  const rng = createRng(seedText);
  const { pots, potCount, remainder } = buildPots(activeTeams, groupCount);

  const groups = Array.from({ length: groupCount }, () => []);
  const retries = [];
  let conflictRetries = 0;
  let seq = 0;
  let stopReason = '';
  // 触顶停下时冻结当时的部分落位，不被回溯撤销，页面能看到已经抽好的部分
  let frozen = null;
  // 回溯搜索树本身有限，但档多组大时组合可能很多；节点上限是重试上限之外的第二道保险
  const nodeCap = maxRetries * 50 + 10000;
  let nodes = 0;

  function log(entry) {
    seq += 1;
    if (retries.length < RETRY_LOG_LIMIT) retries.push({ seq, ...entry });
  }

  function hasCityClash(groupIndex, team) {
    return groups[groupIndex].some((member) => member.city && member.city === team.city);
  }

  function clashMember(groupIndex, team) {
    return groups[groupIndex].find((member) => member.city && member.city === team.city);
  }

  // pot：第几档（0 起）；slot：这一档抽到第几支球队；order：本档球队的随机抽取顺序
  function halt(reason) {
    if (stopReason) return;
    stopReason = reason;
    // 冻结此刻各组已经落位的球队，回溯过程中不再撤销它们
    frozen = groups.map((group) => group.slice());
  }

  function assign(pot, slot, order) {
    if (stopReason) return false;
    if (pot >= potCount) return true;
    if (slot >= groupCount) return assign(pot + 1, 0, pot + 1 < potCount ? shuffle(pots[pot + 1], rng) : null);

    nodes += 1;
    if (nodes > nodeCap) {
      halt(`落位组合尝试超过安全上限（${nodeCap} 种）仍未避开同城冲突，停止抽签以免无限重试；某城市的球队可能多过组数，可增加组数或换种子再试`);
      return false;
    }

    const team = order[slot];
    // 这一档位上已经有队的组（组长度已超过当前档）不能再落，每组每档恰一支
    const taken = new Set();
    groups.forEach((g, gIndex) => {
      if (g.length > pot) taken.add(gIndex);
    });

    const candidates = shuffle(Array.from({ length: groupCount }, (_, i) => i), rng)
      .filter((gIndex) => !taken.has(gIndex));

    for (const groupIndex of candidates) {
      if (stopReason) return false;
      if (hasCityClash(groupIndex, team)) {
        conflictRetries += 1;
        const blocker = clashMember(groupIndex, team);
        log({
          kind: '回避重试',
          potNo: pot + 1,
          teamId: team.id,
          teamName: team.name,
          city: team.city,
          groupNo: groupIndex + 1,
          blockedBy: blocker ? { teamId: blocker.id, name: blocker.name } : null,
          retryCount: conflictRetries,
          message: `第 ${pot + 1} 档：${team.name}（${team.city}）先抽中第 ${groupIndex + 1} 组，但该组已有 ${blocker ? blocker.name : '同城球队'}（${team.city}），按同城回避改抽其他组（第 ${conflictRetries} 次重试）`,
        });
        if (conflictRetries >= maxRetries) {
          halt(`同城回避重试已达上限 ${maxRetries} 次，仍然有球队无法与同城球队拆开；抽签在此停止，不会继续死循环。可换一个种子编号、调高重试上限，或把组数改多一些再抽`);
          return false;
        }
        continue;
      }

      groups[groupIndex][pot] = team;
      if (assign(pot, slot + 1, order)) return true;
      if (stopReason) return false;
      groups[groupIndex].pop();
      log({
        kind: '退档重抽',
        potNo: pot + 1,
        teamId: team.id,
        teamName: team.name,
        city: team.city,
        groupNo: null,
        blockedBy: null,
        retryCount: conflictRetries,
        message: `第 ${pot + 1} 档：${team.name}（${team.city}）余下的空组都会撞上同城球队，退回本档让它改投别的组重新落位`,
      });
    }
    return false;
  }

  const complete = assign(0, 0, shuffle(pots[0], rng));
  // 停顿（重试触顶/节点上限）时用冻结的部分落位；正常走完用完整分组
  const snapshot = frozen || groups;
  if (!complete && !stopReason) {
    stopReason = `在 ${maxRetries} 次回避重试的范围内试遍了落位组合，仍无法把同城球队全部分开；按当前组数与城市分布不存在可行分组，请增加组数、调整参赛球队后再抽，不会继续死等下去`;
  }

  const resultGroups = snapshot.map((members, gIndex) => ({
    groupNo: gIndex + 1,
    teams: members.map((team, pot) => ({ ...teamBrief(team), potNo: pot + 1, groupNo: gIndex + 1 })),
  }));

  const assignedIds = new Set();
  const assignmentList = [];
  snapshot.forEach((members, gIndex) => {
    members.forEach((team, pot) => {
      assignedIds.add(team.id);
      assignmentList.push({ ...teamBrief(team), potNo: pot + 1, groupNo: gIndex + 1 });
    });
  });
  assignmentList.sort((a, b) => (a.seedRank - b.seedRank) || (a.teamId < b.teamId ? -1 : 1));

  const leftovers = remainder.map((team) => ({
    ...teamBrief(team),
    potNo: null,
    groupNo: null,
    reason: `参赛队共 ${activeTeams.length} 支、分 ${groupCount} 组时每组 ${potCount} 支，只需要 ${potCount * groupCount} 支；这是多出来的第 ${team.seedRank} 名，凑不齐完整一档，不进抽签`,
  }));

  // 重试上限触顶时，已部分落位的保留展示，还没落位的入签球队单独列出并说明
  const undrawable = [];
  if (!complete) {
    activeTeams
      .filter((team) => !assignedIds.has(team.id) && !leftovers.some((item) => item.teamId === team.id))
      .forEach((team) => {
        undrawable.push({
          ...teamBrief(team),
          potNo: null,
          groupNo: null,
          reason: stopReason,
        });
      });
  }

  return {
    seed: seedText,
    groupCount,
    potCount,
    perGroup: potCount,
    complete,
    retryCount: conflictRetries,
    retryLogTotal: seq,
    retryLogShown: retries.length,
    retryLogTruncated: seq > retries.length,
    retries,
    groups: resultGroups,
    assignments: assignmentList,
    leftovers,
    undrawable,
    message: complete
      ? `抽签完成：${groupCount} 个组各 ${potCount} 支，共回避同城重试 ${conflictRetries} 次`
      : stopReason,
  };
}

function performDraw(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const seedText = pickText(source.seed);
  if (!seedText) throw new ApiError(400, 'SEED_REQUIRED', '请填写种子编号，同一种子才能复现同一次抽签', 'seed');
  if (seedText.length > SEED_MAX_LENGTH) {
    throw new ApiError(400, 'SEED_TOO_LONG', `种子编号不能超过 ${SEED_MAX_LENGTH} 个字符`, 'seed');
  }
  const data = load();
  const active = data.teams.filter((team) => team.status === '参赛');
  if (active.length < 2) {
    throw new ApiError(409, 'NOT_ENOUGH_TEAMS', '参赛球队不足两支，至少要两支才能分组抽签', 'seed');
  }
  const groupCount = resolveGroupCount(active.length, source.groupCount);
  const maxRetries = resolveMaxRetries(source.maxRetries);
  const result = runDraw(active, { seedText, groupCount, maxRetries });
  return {
    season: data.meta.season,
    activeCount: active.length,
    teamCount: data.teams.length,
    withdrawnTeams: data.teams
      .filter((team) => team.status !== '参赛')
      .map((team) => ({ ...teamBrief(team), status: team.status })),
    ...result,
  };
}

module.exports = {
  previewDraw,
  performDraw,
  runDraw,
  buildPots,
  createRng,
  DEFAULT_MAX_RETRIES,
  SEED_MAX_LENGTH,
};
