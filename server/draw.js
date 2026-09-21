// 分组抽签：按上赛季名次分档，逐档随机落位，同城球队互相回避。
// 本模块是无状态纯函数，不读写数据文件——同一批球队、同样的参数与种子编号，
// 无论抽多少次都得到完全一样的结果；抽签结果不落库，只把结果返回给页面。
const crypto = require('crypto');
const { ApiError } = require('./errors');

const GROUP_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DEFAULT_MAX_RETRIES = 50;
const MAX_RETRY_LIMIT = 500;
const MAX_SEED_LEN = 64;

// 字符串种子编号 -> 32 位无符号整数：xmur3 哈希。
// 同样的编号一定得到同样的整数，再交给确定性伪随机数发生器。
function hashSeed(input) {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

// mulberry32：一个 32 位整数种子对应一条确定的随机数序列，调用一次出一个 [0,1) 数
function createRng(seed32) {
  let a = seed32 >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// 把球队字段整理成抽签里用的精简结构，名次、城市都来自球队档案
function simplifyTeam(item) {
  return {
    id: item.id,
    name: item.name,
    shortName: item.shortName,
    city: item.city || '',
    seedRank: item.seedRank,
  };
}

// 参赛球队按名次排好，切成若干满档；最后一个不满档的不参与抽签
function buildPots(activeTeams, groupSize) {
  const groupCount = groupSize;
  const potCount = activeTeams.length >= groupCount
    ? Math.floor(activeTeams.length / groupCount)
    : 0;
  const placedCount = potCount * groupCount;
  const pots = [];
  for (let p = 0; p < potCount; p += 1) {
    const slice = activeTeams.slice(p * groupCount, (p + 1) * groupCount);
    pots.push({
      potNo: p + 1,
      rankFrom: slice[0].seedRank,
      rankTo: slice[slice.length - 1].seedRank,
      teams: slice.map(simplifyTeam),
    });
  }
  const remainder = activeTeams.slice(placedCount).map(simplifyTeam);
  return { groupSize, groupCount, potCount, placedCount, pots, remainder };
}

// 读取并校验小组数量：必须是 2 到参赛队数之间的整数
function readGroupSize(source, teamCount) {
  const raw = source && source.groupSize !== undefined && source.groupSize !== null && source.groupSize !== ''
    ? Number(source.groupSize)
    : NaN;
  if (!Number.isInteger(raw) || raw < 2 || raw > teamCount) {
    throw new ApiError(400, 'GROUP_SIZE_INVALID', `小组数量要填 2 到 ${teamCount} 之间的整数`, 'groupSize');
  }
  return raw;
}

// 读取并校验重试上限：0 到 500 的整数，缺省 50
function readMaxRetries(source) {
  if (!source || source.maxRetries === undefined || source.maxRetries === null || trimText(String(source.maxRetries)) === '') {
    return DEFAULT_MAX_RETRIES;
  }
  const raw = Number(source.maxRetries);
  if (!Number.isInteger(raw) || raw < 0 || raw > MAX_RETRY_LIMIT) {
    throw new ApiError(400, 'RETRY_INVALID', `重试上限要填 0 到 ${MAX_RETRY_LIMIT} 之间的整数`, 'maxRetries');
  }
  return raw;
}

// 读取种子编号：留空则现场随机生成一个（日期+随机后缀），最长 64 字
function readSeed(source) {
  const raw = trimText(source && source.seed);
  if (raw.length > MAX_SEED_LEN) {
    throw new ApiError(400, 'SEED_INVALID', `种子编号不能超过 ${MAX_SEED_LEN} 个字`, 'seed');
  }
  if (raw) return raw;
  const today = new Date();
  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

// 随机落位一整档：把小组号洗成一个排列，与按名次排好的球队一一配对，
// 这样每档自然给每个小组恰好一支队。排列里只要有一支抽到同城，本次抽签作废、
// 整档重新洗一次并记一次重试（第一次正式抽签不计重试）；重洗达到上限仍不行返回 null，
// 交给确定性匹配兜底，保证不会无限循环。
function placePotRandom(potTeams, citySets, rng, maxRetries, potNo, retries) {
  const groupCount = citySets.length;
  for (let drawNo = 0; drawNo <= maxRetries; drawNo += 1) {
    const order = shuffle(Array.from({ length: groupCount }, (_, g) => g), rng);
    const blocked = [];
    for (let j = 0; j < potTeams.length; j += 1) {
      if (citySets[order[j]].has(potTeams[j].city)) {
        blocked.push({
          teamId: potTeams[j].id,
          teamName: potTeams[j].name,
          city: potTeams[j].city,
          groupNo: order[j] + 1,
        });
      }
    }
    if (blocked.length === 0) {
      return potTeams.map((_, j) => order[j]);
    }
    // 第一次（drawNo=0）抽废了才有"第 1 次重试"；最后一次抽废则不再重洗，交兜底
    if (drawNo < maxRetries) {
      const who = blocked.map((item) => `${item.teamName}(${item.city}→第${item.groupNo}组)`).join('、');
      retries.push({
        attempt: drawNo + 1,
        potNo,
        blocked,
        detail: `第 ${potNo} 档抽签时 ${who} 与同组已有球队同城，本次结果作废，第 ${drawNo + 1} 次重新落位`,
      });
    }
  }
  return null;
}

// 确定性兜底：在"球队—可选组"二分图里求最大匹配（Kuhn 增广路）。
// 遍历顺序固定（球队按传入顺序、组按序号），结果同样可由种子之外的输入复现。
function matchGroups(potTeams, citySets) {
  const matchGroup = new Array(citySets.length).fill(-1); // 每组当前匹配的球队下标

  const tryAugment = (teamIndex, seen) => {
    const team = potTeams[teamIndex];
    for (let g = 0; g < citySets.length; g += 1) {
      if (citySets[g].has(team.city) || seen.has(g)) continue;
      seen.add(g);
      if (matchGroup[g] === -1 || tryAugment(matchGroup[g], seen)) {
        matchGroup[g] = teamIndex;
        return true;
      }
    }
    return false;
  };

  for (let t = 0; t < potTeams.length; t += 1) {
    tryAugment(t, new Set());
  }

  const placement = new Array(potTeams.length).fill(-1);
  matchGroup.forEach((teamIndex, g) => {
    if (teamIndex !== -1) placement[teamIndex] = g;
  });
  return placement;
}

// 抽签主流程。activeTeams 为已按 seedRank 升序的参赛球队（精简或完整结构均可）
function drawGroups(activeTeams, options) {
  const input = options && typeof options === 'object' ? options : {};
  const teams = activeTeams.map(simplifyTeam).sort((a, b) => a.seedRank - b.seedRank);
  if (teams.length < 2) {
    throw new ApiError(400, 'DRAW_TEAMS_TOO_FEW', '参赛球队不足 2 支，先到球队页登记再抽签', '');
  }
  const groupSize = readGroupSize(input, teams.length);
  const maxRetries = readMaxRetries(input);
  const seed = readSeed(input);

  const rng = createRng(hashSeed(seed)());
  const built = buildPots(teams, groupSize);
  const { pots, remainder, groupCount, potCount } = built;

  // 每组先放好空容器，并记录每组已有的城市，用于同城回避
  const groups = [];
  for (let g = 0; g < groupCount; g += 1) {
    groups.push({ groupNo: g + 1, groupLabel: `${GROUP_LABELS[g] || g + 1}组`, size: 0, teams: [] });
  }
  const citySets = Array.from({ length: groupCount }, () => new Set());
  const assignments = [];
  const retries = [];
  const notices = [];
  const leftovers = remainder.map((team) => ({
    teamId: team.id,
    name: team.name,
    city: team.city,
    seedRank: team.seedRank,
    reason: `参赛队共 ${teams.length} 支、分成 ${groupCount} 个小组，每档 ${groupCount} 支只能凑满 ${potCount} 档；该队排在第 ${team.seedRank} 位，属于最后一个不满档，无法保证各组队数相等`,
  }));

  pots.forEach((pot) => {
    const potTeams = pot.teams;
    // 整档随机排列落位；失败不改动各组状态，直接换确定性匹配兜底
    const randomPlacement = placePotRandom(potTeams, citySets, rng, maxRetries, pot.potNo, retries);
    let placement;
    if (randomPlacement) {
      placement = randomPlacement;
    } else {
      notices.push(`第 ${pot.potNo} 档随机重试 ${maxRetries} 次后仍无法让整档避开同城球队，本档改用确定性匹配落位`);
      placement = matchGroups(potTeams, citySets);
    }

    potTeams.forEach((team, index) => {
      const g = placement[index];
      if (g === -1 || g === undefined) {
        leftovers.push({
          teamId: team.id,
          name: team.name,
          city: team.city,
          seedRank: team.seedRank,
          reason: `同城回避无法满足：第 ${pot.potNo} 档落位时，${team.city} 的球队数量已达到或超过小组总数 ${groupCount}，数学上无法把它们全部分到不同组`,
        });
        notices.push(`${team.name}（${team.city}）在第 ${pot.potNo} 档无法回避同城球队，已列入"落不下的球队"；受此影响，相关小组少一支球队`);
        return;
      }
      citySets[g].add(team.city);
      groups[g].teams.push({ ...team, potNo: pot.potNo });
      groups[g].size += 1;
      assignments.push({
        teamId: team.id,
        name: team.name,
        city: team.city,
        seedRank: team.seedRank,
        potNo: pot.potNo,
        groupNo: g + 1,
        groupLabel: groups[g].groupLabel,
      });
    });
  });

  if (remainder.length > 0) {
    notices.push(`有 ${remainder.length} 支球队排在最后一个不满档（名次第 ${remainder[0].seedRank} 位之后），为保证各组队数相等未参与抽签，已列入"落不下的球队"`);
  }

  const sizes = groups.map((group) => group.size);
  const groupSizeEqual = sizes.every((size) => size === sizes[0]);
  const actualPlaced = assignments.length;

  return {
    seed,
    groupSize,
    groupCount,
    potCount,
    teamCount: teams.length,
    placedCount: actualPlaced,
    groupSizeEqual,
    expectedPerGroup: potCount,
    pots: pots.map((pot) => ({
      potNo: pot.potNo,
      rankFrom: pot.rankFrom,
      rankTo: pot.rankTo,
      teams: pot.teams,
    })),
    groups,
    assignments,
    retries,
    leftovers,
    notices,
  };
}

module.exports = {
  buildPots,
  drawGroups,
  hashSeed,
  createRng,
  readGroupSize,
  readMaxRetries,
  readSeed,
  DEFAULT_MAX_RETRIES,
  MAX_RETRY_LIMIT,
  GROUP_LABELS,
};
